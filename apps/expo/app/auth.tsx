import { Redirect, useRouter } from "expo-router";

import { AuthScreen } from "../src/features/onboarding/screens/AuthScreen";

import { routeToHref, useOnboarding } from "./_layout";

export default function AuthRoute() {
  const router = useRouter();
  const { controller, state } = useOnboarding();

  if (state.route !== "needsAuth") {
    const href = routeToHref(state.route);
    return <Redirect href={href ?? "/"} />;
  }

  return (
    <AuthScreen
      errorMessage={state.errorMessage}
      isBusy={state.isBusy}
      pendingEmail={state.pendingEmailOTPEmail}
      onBack={() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace("/choose-auth");
        }
      }}
      onRequestOtp={controller.requestOtp}
      onResetPendingEmail={controller.resetPendingEmail}
      onVerifyOtp={controller.verifyOtp}
    />
  );
}
