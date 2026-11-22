// Half-duplex: the dictation helper is Apple's SFSpeechRecognizer on raw AVAudioEngine input with no echo cancellation,
// so a mic open during playback transcribes the bot's own voice back. The buffer-backed recognizer does not finalize on
// silence; the helper ends the stream.
import { useCallback, useEffect, useRef, useState } from "react";

import { currentCall, deferCallCleanup } from "@/lib/call";
import { callTonesAllowed, RING_PHRASE_MS } from "@/lib/call-sounds";
import { beginCallSession, patchCallSession, pushCaption, turnsActions, useCallSession } from "@/lib/call-session";
import { turnsCallProvider } from "@/lib/call-provider";
import { callLanguage } from "../../shared/call-voice";
import { NO, YES } from "../../shared/call-consent";
import { t } from "@/lib/i18n";
import { speaker } from "@/lib/tts";
import { usePushToTalk } from "@/lib/push-to-talk";
import { CALL_ENDPOINT_MS, speechBridge } from "@/lib/speech";
import { visibleMessages, useStore, type Bot } from "@/state/store";
import { isRoutineApproval, isSkillApproval, pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";
import { titledCard } from "./ApprovalCard";

type Phase = "listening" | "sending" | "working" | "speaking";

const QUIET_CONNECT_MS = 800;

/** Runs the Turns call for one bot and mirrors what the call view shows into the call session. It draws nothing. */
export function TurnsCall({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const config = state.config;
  // One bridge for the whole call: a voice change mid-call must not stop or hear through another.
  const [bridge] = useState(() => speechBridge(state.config));
  const initialPhase: Phase = bot.busy ? "working" : "listening";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const { muted } = useCallSession();
  const mutedRef = useRef(false);
  const connectedRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const pushToTalk = usePushToTalk(bot.id, bridge, phase === "listening" && connected && !muted, () => {
    setNote(t("call.turns.pushToTalkFailed"));
  });
  const botRef = useRef(bot);

  const messages = visibleMessages(bot);
  const approval = pendingApprovals(messages)[0];
  const question = messages.find(
    (message) =>
      message.kind === "options" &&
      message.card?.requestId &&
      !message.card.tool &&
      !message.card.answered &&
      !message.card.dismissed,
  );

  const spokenIds = useRef<Set<string>>(new Set());
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    for (const m of messages) spokenIds.current.add(m.id);
  }

  const askedApproval = useRef<{
    requestId: string;
    routine: boolean;
    skill: boolean;
    submitted: boolean;
  } | null>(null);
  const askedQuestion = useRef<{ requestId: string; messageId: string } | null>(null);
  const phaseRef = useRef<Phase>(initialPhase);
  const alive = useRef(true);
  const sayGeneration = useRef(0);

  /** React state alone is too late: the helper can exit in the same tick as a final transcript or a mute. */
  const move = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (alive.current) setPhase(next);
  }, []);

  const hush = useCallback(() => {
    void bridge?.speechStop();
  }, [bridge]);

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== bot.id) return;
    move("listening");
    setHeard("");
    setNote(null);
    if (mutedRef.current || !connectedRef.current) return;
    const spoken = callLanguage(botRef.current.callLanguage);
    void bridge?.speechStart({ endpointMs: CALL_ENDPOINT_MS, ...(spoken ? { locale: spoken.code } : {}) }).catch(() => {
      if (alive.current && currentCall() === bot.id) {
        setNote(t("call.turns.micFailed"));
      }
    });
  }, [bridge, bot.id, move]);

  const say = useCallback(
    async (text: string) => {
      if (!alive.current || currentCall() !== bot.id) return false;
      const mine = ++sayGeneration.current;
      // Move first: stopSpeech() closes asynchronously and must never observe an old "listening" phase and reopen the
      // mic.
      move("speaking");
      hush();
      pushCaption("bot", text);
      const current = botRef.current;
      await speaker.speak(text, {
        botId: bot.id,
        voiceId: current.voice,
        call: { provider: turnsCallProvider(config), speed: current.callSpeed, language: current.callLanguage },
      });
      return alive.current && currentCall() === bot.id && sayGeneration.current === mine;
    },
    [bot.id, config, hush, move],
  );

  const sayThenListen = useCallback(
    async (text: string) => {
      const stillMine = await say(text);
      if (stillMine && phaseRef.current === "speaking") listen();
    },
    [listen, say],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sayGeneration.current += 1;
      // StrictMode remounts effects once in development; a microtask tells that probe from real navigation.
      deferCallCleanup(bot.id, () => alive.current);
    };
  }, [bot.id]);

  useEffect(() => {
    if (!bridge) return;
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (!alive.current || currentCall() !== bot.id || phaseRef.current !== "listening") return;
      if (line.error) {
        setNote(t("call.turns.dictationStopped"));
        return;
      }
      if (typeof line.text !== "string") return;
      setHeard(line.text);
      if (line.partial !== false) return;
      const said = line.text.trim();
      if (!said) return listen();
      pushCaption("you", said);

      const open = askedApproval.current;
      if (open) {
        if (open.submitted) {
          move("working");
          hush();
          return;
        }
        if (YES.test(said) || NO.test(said)) {
          const allow = YES.test(said);
          if (allow && open.skill) {
            setHeard("");
            void sayThenListen("Open this chat to review the complete skill before approving it. You can say no now to deny it.");
            return;
          }
          // Stay claimed until the server's card patch arrives, or a render in that gap submits the same approval
          // again.
          open.submitted = true;
          move("working");
          hush();
          setHeard("");
          dispatch({
            type: "decideRequest",
            threadId: bot.threadId,
            requestId: open.requestId,
            behavior: allow ? "allow" : "deny",
            message: allow ? undefined : "Denied by the user, on a call.",
            onError: (error: string) => {
              const pending = askedApproval.current;
              if (
                !alive.current ||
                currentCall() !== bot.id ||
                pending?.requestId !== open.requestId ||
                !pending.submitted
              ) return;
              pending.submitted = false;
              const detail = error.trim().slice(0, 240);
              const decision = open.routine ? "routine decision" : "approval";
              void sayThenListen(
                `I couldn't save that ${decision}${detail ? `: ${detail}` : "."} Please try again.`,
              );
            },
          });
          return;
        }
        void sayThenListen("Sorry — is that a yes or a no?");
        return;
      }

      const openQuestion = askedQuestion.current;
      if (openQuestion) {
        askedQuestion.current = null;
        dispatch({ type: "answerCard", botId: bot.id, threadId: bot.threadId, messageId: openQuestion.messageId, answer: said });
        move("working");
        return;
      }

      move("sending");
      dispatch({ type: "send", botId: bot.id, text: said, threadId: bot.threadId });
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason, message }) => {
      if (!alive.current || currentCall() !== bot.id) return;
      if (code === 2) {
        setNote(t("call.turns.needsDictation"));
        return;
      }
      if (code === 1) {
        setNote(
          message ?? t(reason === "helper-build-failed"
            ? "call.turns.helperBuildFailed"
            : reason === "dictation-disabled"
              ? "composer.dictation.disabled"
              : reason === "speech-not-authorized"
                ? "call.turns.speechNotAuthorized"
                : "composer.dictation.failed"),
        );
        return;
      }
      if (phaseRef.current === "listening") listen();
    });
    if (connectedRef.current) {
      if (bot.busy && !approval && !question) move("working");
      else listen();
    }
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, bot.threadId, bridge, dispatch, hush, listen, move, sayThenListen]);

  useEffect(() => {
    // The card may be resolved elsewhere (the approval UI, another client) while this call is open.
    let resumeAfterRoutine = false;
    if (askedApproval.current && approval?.requestId !== askedApproval.current.requestId) {
      resumeAfterRoutine = askedApproval.current.routine && askedApproval.current.submitted;
      askedApproval.current = null;
    }
    if (askedQuestion.current && question?.card?.requestId !== askedQuestion.current.requestId) {
      askedQuestion.current = null;
    }
    if (!approval && !question && bot.busy && phaseRef.current === "listening") {
      move("working");
      hush();
    }
    if (resumeAfterRoutine && !approval && !question && !bot.busy) {
      listen();
      return;
    }
    // Nothing may reopen capture or narrate new work while the server is
    // durably settling this exact decision.
    if (askedApproval.current?.submitted) return;
    if (approval && askedApproval.current?.requestId !== approval.requestId && phase !== "speaking") {
      askedApproval.current = {
        requestId: approval.requestId,
        routine: isRoutineApproval(approval),
        skill: isSkillApproval(approval),
        submitted: false,
      };
      spokenIds.current.add(approval.message.id);
      const skillPrompt = approval.message.card?.skillRequest?.action === "update"
        ? `${bot.name} wants to update a learned skill. Open this chat to review the complete skill before replacing the current version. You can say no to deny it.`
        : `${bot.name} wants to enable a new learned skill. Open this chat to review the complete skill before enabling it. You can say no to deny it.`;
      void sayThenListen(isSkillApproval(approval) && !titledCard(approval.message.card) ? skillPrompt : spokenApprovalPrompt(approval, bot.name));
      return;
    }
    if (
      question?.card?.requestId &&
      askedQuestion.current?.requestId !== question.card.requestId &&
      phase !== "speaking"
    ) {
      askedQuestion.current = { requestId: question.card.requestId, messageId: question.id };
      spokenIds.current.add(question.id);
      const detail = question.card.subtitle.trim();
      const choices = question.card.options.length
        ? ` The options are ${question.card.options.join(", ")}.`
        : "";
      void sayThenListen(`${bot.name} asks: ${detail}${/[.!?]$/.test(detail) ? "" : "."}${choices}`);
      return;
    }
    const fresh = messages.filter((m) => !spokenIds.current.has(m.id));
    if (!fresh.length) return;
    const reply = [...fresh].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.text?.trim());
    const chip = [...fresh].reverse().find((m) => m.kind === "activity" && m.tool?.spoken);
    for (const m of fresh) spokenIds.current.add(m.id);

    if (reply?.text) {
      void sayThenListen(reply.text);
    } else if (chip?.tool?.spoken && phase === "working") {
      void say(chip.tool.spoken).then((stillMine) => {
        if (stillMine && phaseRef.current === "speaking") move("working");
      });
    }
  }, [messages, approval, question, phase, bot.busy, bot.name, hush, listen, move, say, sayThenListen]);

  useEffect(() => {
    if (bot.busy) {
      // An open approval keeps the mic live for yes/no; every other busy phase is half-duplex and must close capture.
      if (phaseRef.current !== "speaking" && !askedApproval.current && !askedQuestion.current) {
        move("working");
        hush();
      }
    } else if (
      phaseRef.current === "working" &&
      !askedApproval.current &&
      !askedQuestion.current &&
      !speaker.isSpeaking()
    ) {
      listen();
    }
  }, [bot.busy, hush, listen, move]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && speaker.isSpeaking()) {
        e.preventDefault();
        sayGeneration.current += 1;
        speaker.stop();
        listen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listen]);

  useEffect(() => {
    botRef.current = bot;
  });

  useEffect(() => {
    beginCallSession(bot.id);
    if (connectedRef.current) return;
    const timer = setTimeout(() => {
      connectedRef.current = true;
      setConnected(true);
      patchCallSession({ stage: "connected", startedAt: Date.now() });
    }, callTonesAllowed() ? RING_PHRASE_MS : QUIET_CONNECT_MS);
    return () => clearTimeout(timer);
  }, [bot.id]);

  useEffect(() => {
    if (!connected) return;
    if (bot.busy && !approval && !question) move("working");
    else listen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  useEffect(() => {
    mutedRef.current = muted;
    if (muted) hush();
    else if (connectedRef.current && phaseRef.current === "listening") listen();
  }, [muted, hush, listen]);

  useEffect(() => {
    turnsActions.retry = listen;
    turnsActions.interrupt = () => {
      sayGeneration.current += 1;
      speaker.stop();
      listen();
    };
    return () => {
      turnsActions.retry = null;
      turnsActions.interrupt = null;
    };
  }, [listen]);

  useEffect(() => {
    patchCallSession({
      presence: phase === "listening" ? "listening" : phase === "speaking" ? "speaking" : "thinking",
      heard,
      note,
      pushToTalk,
      canInterrupt: phase === "speaking",
    });
  }, [phase, heard, note, pushToTalk]);

  return null;
}
