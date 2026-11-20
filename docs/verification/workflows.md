# Workflows

A workflow is a set of steps that bots take one after another. A person draws
it on a canvas under Automations, in Workflows, and gives it to a routine.

## What to check

- **Empty list.** Workflows shows a short sentence and a New workflow button.
- **Canvas.** New workflow opens an editor. Rename the workflow. Add two Bot
  steps, one with a click and one with the keyboard. The palette joins the
  second step to the first. Choose a bot and write an instruction for each.
- **AI check.** Add an AI check after the second step. Add a step after it. The
  new step sits on the Yes branch.
- **Autosave.** Wait for Saved. Reload the page. The name, the steps and the
  connections come back.
- **Undo.** Delete a step. Press Undo. The step and its connections come back.
- **Routine.** In a routine editor, choose Workflow in What it does. Press Use
  beside the workflow. The slot shows the workflow as In use. Save. The routine
  now runs that workflow.
- **Run view.** A failed run shows the steps that finished as done and the step
  that failed as failed. The failed step is selected and shows what went wrong.
  Run again from here starts a new run. Steps that finished before the failure
  carry over. Runs of this routine lists both runs.

## Automated check

Each file starts the real server in a temporary home, with a scripted engine,
and drives the real renderer in headless Chrome. It never touches a running
Seira or its data.

```sh
SEIRA_UI_E2E=1 pnpm exec vitest run scripts/testing/workflow-canvas-ui.e2e.test.ts
SEIRA_UI_E2E=1 pnpm exec vitest run scripts/testing/workflow-run-ui.e2e.test.ts
```

Without `SEIRA_UI_E2E=1` both files are skipped. Set `SEIRA_WORKFLOW_SHOTS` to a
folder to keep the screenshots there. Each screen is captured in Midnight and in
Daylight. The files end by checking that the browser console has no errors.

- `scripts/testing/workflow-canvas-ui.e2e.test.ts` covers the empty list, drawing, autosave,
  reload, delete and Undo, and giving the workflow to a routine. It reads the
  saved workflow and routine from the API.
- `scripts/testing/workflow-run-ui.e2e.test.ts` seeds a two-step workflow and a routine, makes
  the second step fail, opens the run from the routine panel, then runs it again
  from the failed step once the script lets it finish.

## What the screenshots must show

Check each pair, Midnight and Daylight, for these points:

| Screenshot | Must show |
|------------|-----------|
| `list-empty` | The sleeping character, one sentence, the New workflow button. |
| `list-with-workflow` | One row with a thumbnail, the name, 4 steps, the bot names. |
| `editor-panel-open` | The palette, four steps with connections, the Step settings panel beside the canvas. |
| `routine-slot` | What it does set to Workflow, the chosen workflow marked In use with a Remove button. |
| `routine-panel-steps` | The two steps of the last run, one done and one failed, and an Open button. |
| `run-failed` | Step 1 done, step 2 failed and selected, the error sentence in the Result panel, Run again from here. |
| `run-finished` | Both steps done, the output of step 2 in the Result panel, two runs listed. |

In both skins, text must not overlap or be cut off, text and status marks must
be readable on their card, and cards, panels and the canvas must use the colors
of the skin. No area that should hold content may be empty.
