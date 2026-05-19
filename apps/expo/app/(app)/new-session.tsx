import { useRouter } from "expo-router";
import { useState } from "react";

import { NewSessionScreen } from "../../src/features/sessions/screens/NewSessionScreen";

/**
 * Modal route for "New session". Stub today: collects a first message, then
 * dismisses. The real session-creation pipeline (collaborator picker,
 * agent_runtimes seed, Supabase insert) lands with Sub-spec #2d.
 */
export default function NewSessionRoute() {
  const router = useRouter();
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  return (
    <NewSessionScreen
      errorMessage={errorMessage}
      isBusy={isBusy}
      onClose={() => router.back()}
      onCreate={async () => {
        setIsBusy(true);
        setErrorMessage(null);
        // Placeholder — Sub-spec #2d wires this up to the Supabase insert
        // path and the matched MQTT subscribe used by iOS NewSessionSheet.
        await new Promise((resolve) => setTimeout(resolve, 600));
        setIsBusy(false);
        setErrorMessage("Session creation lands in Sub-spec #2d — not yet wired up.");
      }}
    />
  );
}
