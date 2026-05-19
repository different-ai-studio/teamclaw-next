import {
  initialOnboardingState,
  onboardingReducer,
} from "./onboarding-reducer";
import type {
  OnboardingAction,
  OnboardingState,
} from "./onboarding-types";
type OnboardingApi = ReturnType<
  (typeof import("../../lib/supabase/onboarding-api"))["createOnboardingApi"]
>;

type OnboardingListener = () => void;

const SAFE_BOOTSTRAP_ERROR =
  "We couldn't load your account right now. Please try again.";

class BootstrapFailureError extends Error {
  constructor(public readonly cause: unknown) {
    super("Bootstrap failed");
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}

export function createOnboardingController(api: OnboardingApi) {
  let state: OnboardingState = initialOnboardingState;
  let activeOperationToken = 0;
  const listeners = new Set<OnboardingListener>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setState = (nextState: OnboardingState) => {
    state = nextState;
    notify();
  };

  const dispatch = (action: OnboardingAction) => {
    setState(onboardingReducer(state, action));
  };

  const beginOperation = () => {
    activeOperationToken += 1;
    return activeOperationToken;
  };

  const isActiveOperation = (token: number) => token === activeOperationToken;

  const dispatchIfCurrent = (token: number, action: OnboardingAction) => {
    if (isActiveOperation(token)) {
      dispatch(action);
    }
  };

  const finishWithError = (token: number, message: string) => {
    if (!isActiveOperation(token)) {
      return;
    }

    setState({
      ...state,
      isBusy: false,
      errorMessage: message,
    });
  };

  const bootstrap = async (existingToken?: number) => {
    const token = existingToken ?? beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });

    try {
      const session = await api.getCurrentSession();
      if (session === null) {
        dispatchIfCurrent(token, { type: "signedOut" });
        return;
      }

      const payload = await api.loadBootstrap();
      dispatchIfCurrent(token, { type: "bootstrapResolved", payload });
    } catch (error) {
      dispatchIfCurrent(token, {
        type: "bootstrapFailed",
        message: SAFE_BOOTSTRAP_ERROR,
      });
      if (existingToken === undefined) {
        throw error;
      }
      throw new BootstrapFailureError(error);
    }
  };

  const signInAnonymously = async () => {
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });

    try {
      await api.signInAnonymously();
      await bootstrap(token);
    } catch (error) {
      if (!(error instanceof BootstrapFailureError)) {
        finishWithError(token, toErrorMessage(error));
      }
      throw (error instanceof BootstrapFailureError ? error.cause : error);
    }
  };

  const requestOtp = async (email: string) => {
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });

    try {
      const { pendingEmail } = await api.sendEmailOTP(email);
      dispatchIfCurrent(token, { type: "otpRequested", email: pendingEmail });
    } catch (error) {
      finishWithError(token, toErrorMessage(error));
      throw error;
    }
  };

  const verifyOtp = async (token: string) => {
    const email = state.pendingEmailOTPEmail;
    if (!email) {
      throw new Error("No pending email OTP request");
    }

    const operationToken = beginOperation();
    dispatchIfCurrent(operationToken, { type: "beginBusy" });

    try {
      await api.verifyOTP(email, token);
      await bootstrap(operationToken);
    } catch (error) {
      if (!(error instanceof BootstrapFailureError)) {
        finishWithError(operationToken, toErrorMessage(error));
      }
      throw (error instanceof BootstrapFailureError ? error.cause : error);
    }
  };

  const createTeam = async (name: string) => {
    const token = beginOperation();
    dispatchIfCurrent(token, { type: "beginBusy" });

    try {
      await api.createTeam(name);
      await bootstrap(token);
    } catch (error) {
      if (!(error instanceof BootstrapFailureError)) {
        finishWithError(token, toErrorMessage(error));
      }
      throw (error instanceof BootstrapFailureError ? error.cause : error);
    }
  };

  const signOut = async () => {
    const token = beginOperation();
    await api.signOut();
    dispatchIfCurrent(token, { type: "signedOut" });
  };

  return {
    getState() {
      return state;
    },
    subscribe(listener: OnboardingListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bootstrap,
    signInAnonymously,
    requestOtp,
    verifyOtp,
    createTeam,
    signOut,
  };
}
