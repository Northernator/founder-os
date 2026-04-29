/**
 * brand-chat / typography-catalog.ts -- curated Google Fonts pairings.
 *
 * The /type slash command in BrandChatPanel asks Gemini to pick the
 * best three pairings from this list against the brand brief. Two
 * reasons we ship a fixed catalog instead of letting Gemini freestyle
 * font names:
 *   1. Reliability. Models hallucinate Google Font family names that
 *      don't exist (or pick fonts only available on Adobe Fonts /
 *      Typekit). A curated list eliminates that whole error mode.
 *   2. Reasoned variety. Each entry has a `vibe` blurb the model uses
 *      as semantic context. This is more useful for ranking than a
 *      bare name alone, because the brand brief talks in terms of
 *      voice and personality rather than typography jargon.
 *
 * To extend: add entries below in alphabetical-ish order by vibe
 * cluster. Keep the catalog under ~30 -- past that, Gemini's context
 * starts trading variety for token cost without much picking benefit.
 *
 * EVERY heading and body string MUST be a real Google Fonts family
 * name exactly as it appears at fonts.google.com (case-sensitive),
 * since the chat panel builds css2 fetch URLs directly from these.
 */

export type TypographyPairing = {
  heading: string;
  body: string;
  vibe: string;
};

export const TYPOGRAPHY_CATALOG: readonly TypographyPairing[] = [
  {
    heading: "Inter",
    body: "Inter",
    vibe: "modern neutral SaaS, single family for simplicity, software-first",
  },
  {
    heading: "Playfair Display",
    body: "Source Sans 3",
    vibe: "editorial, premium, classic + modern contrast, magazines",
  },
  {
    heading: "Space Grotesk",
    body: "Inter",
    vibe: "geometric tech, clean, dev-focused product brands",
  },
  {
    heading: "DM Serif Display",
    body: "DM Sans",
    vibe: "high-contrast serif, warm, trustworthy, fintech-friendly",
  },
  {
    heading: "Manrope",
    body: "Manrope",
    vibe: "rounded humanist, friendly, approachable, consumer apps",
  },
  {
    heading: "Bebas Neue",
    body: "Roboto",
    vibe: "tall condensed display, bold, sports / lifestyle / energy",
  },
  {
    heading: "Fraunces",
    body: "Fraunces",
    vibe: "expressive variable serif, distinctive, opinionated indie brands",
  },
  {
    heading: "Archivo Black",
    body: "Archivo",
    vibe: "loud dense headings, rebellious, modern industrial",
  },
  {
    heading: "Cormorant Garamond",
    body: "Lato",
    vibe: "literary, refined, elegant, high-end services",
  },
  {
    heading: "Outfit",
    body: "Outfit",
    vibe: "geometric grotesque, contemporary, neutral, design-forward",
  },
  {
    heading: "Crimson Pro",
    body: "Open Sans",
    vibe: "academic, readable, traditional but not stuffy, research / publishing",
  },
  {
    heading: "Plus Jakarta Sans",
    body: "Plus Jakarta Sans",
    vibe: "rounded humanist, friendly tech, startup-grade, fintech / health",
  },
  {
    heading: "Syne",
    body: "Inter",
    vibe: "art-deco-influenced, distinctive, creative agencies, fashion-tech",
  },
  {
    heading: "Big Shoulders Display",
    body: "Roboto",
    vibe: "industrial, masculine, athletic, ALL-CAPS friendly, sports",
  },
  {
    heading: "Marcellus",
    body: "Karla",
    vibe: "luxe small caps, hospitality, fashion, premium retail",
  },
  {
    heading: "Sora",
    body: "Sora",
    vibe: "geometric, sci-fi-leaning, futuristic, AI / dev-tools",
  },
  {
    heading: "Tenor Sans",
    body: "Lato",
    vibe: "minimal, gallery-clean, fashion-forward, art / design",
  },
  {
    heading: "Libre Baskerville",
    body: "Libre Franklin",
    vibe: "trad book serif + modern grotesque body, intellectual, considered",
  },
  {
    heading: "Antonio",
    body: "Roboto",
    vibe: "narrow display, magazine-like, posters, editorial",
  },
  {
    heading: "IBM Plex Serif",
    body: "IBM Plex Sans",
    vibe: "corporate but human, dev-heavy, OpenType-rich, infra / SaaS",
  },
  {
    heading: "Unica One",
    body: "Lato",
    vibe: "narrow uppercase display, minimal, agency / portfolio",
  },
  {
    heading: "Spectral",
    body: "Inter",
    vibe: "warm contemporary serif body-friendly, longform reading, journalism",
  },
];
