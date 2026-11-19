import { useStore } from "@/state/store";
import { ConnectAiDialog } from "./onboarding/ConnectAi";
import { useWelcomeAi } from "./onboarding/welcome-ai";

export function IntroConnectAi({ onClose }: { onClose: () => void }) {
  const { state } = useStore();
  return <ConnectAiDialog tested={useWelcomeAi(state.instances, true)} onClose={onClose} />;
}
