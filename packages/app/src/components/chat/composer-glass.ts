import { cn } from "@/lib/utils";

/** White frost layer — no side borders; composer shell owns the frame. */
export const composerGlassFillClass =
  "bg-[#ffffff]/[0.38] backdrop-blur-2xl backdrop-brightness-110 dark:bg-[#ffffff]/[0.28]";

/** Full-width chrome row inside the stack (divider only). */
export const composerGlassSurfaceClass = cn(
  composerGlassFillClass,
  "box-border w-full border-0 border-b border-border-soft",
);

/** Row inside a shared glass block (approval + agent). */
export const composerGlassChildClass =
  "box-border w-full border-0 bg-transparent shadow-none backdrop-blur-none";

export const composerGlassHoverClass =
  "hover:bg-[#ffffff]/50 dark:hover:bg-[#ffffff]/40";

export const composerGlassFocusClass =
  "focus-visible:bg-[#ffffff]/50 dark:focus-visible:bg-[#ffffff]/40";

/** Single outer card — prototype `.composer-stack`. */
export const composerStackShellClass =
  "box-border w-full overflow-visible rounded-[14px] border border-border bg-paper shadow-[0_6px_28px_-14px_rgba(20,20,15,0.14)]";

export function composerStackFormSlotClass(hasTopChrome: boolean): string {
  return cn(
    "box-border w-full",
    "[&_form]:box-border [&_form]:m-0 [&_form]:block [&_form]:w-full [&_form]:min-w-0",
    "[&_form]:border-0 [&_form]:shadow-none [&_form]:bg-paper",
    hasTopChrome
      ? "[&_form]:rounded-none [&_form]:rounded-b-[14px]"
      : "[&_form]:rounded-none",
  );
}
