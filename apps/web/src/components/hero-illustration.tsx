import Image from "next/image";

/**
 * Faint outline illustration behind the landing hero. Rendered from the
 * hand-supplied /illustrations/hero-desk.svg and unresponsive to input.
 */
export function HeroIllustration() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
      <Image
        src="/illustrations/hero-desk.svg"
        alt=""
        width={1600}
        height={900}
        priority
        className="absolute left-1/2 top-0 w-full -translate-x-1/2 opacity-10 blur-[1px] [mask-image:radial-gradient(70%_40%_at_50%_30%,black,transparent)]"
      />
    </div>
  );
}