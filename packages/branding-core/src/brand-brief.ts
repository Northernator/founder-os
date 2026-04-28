import { z } from "zod";

export const BrandPersonalitySchema = z.enum([
  "bold",
  "minimal",
  "playful",
  "serious",
  "warm",
  "technical",
  "luxe",
  "community",
]);
export type BrandPersonality = z.infer<typeof BrandPersonalitySchema>;

export const ColorPaletteSchema = z.object({
  primary: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Must be hex color"),
  secondary: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  background: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  surface: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  text: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  textMuted: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
});
export type ColorPalette = z.infer<typeof ColorPaletteSchema>;

export const TypographySchema = z.object({
  headingFont: z.string(),
  bodyFont: z.string(),
  monoFont: z.string().optional(),
  headingWeight: z.number().default(700),
  bodyWeight: z.number().default(400),
  scaleBase: z.number().default(16),
});
export type Typography = z.infer<typeof TypographySchema>;

export const LogoSpecSchema = z.object({
  style: z.enum(["wordmark", "lettermark", "icon+wordmark", "abstract"]),
  icon: z.string().optional().describe("Lucide icon name or SVG description"),
  tagline: z.string().optional(),
});
export type LogoSpec = z.infer<typeof LogoSpecSchema>;

export const BrandBriefSchema = z.object({
  ventureId: z.string(),
  ventureSlug: z.string(),
  companyName: z.string(),
  tagline: z.string(),
  mission: z.string(),
  targetAudience: z.string(),
  personality: z.array(BrandPersonalitySchema).min(1).max(3),
  toneOfVoice: z.string(),
  competitors: z.array(z.string()).default([]),
  differentiators: z.array(z.string()).default([]),
  colorPalette: ColorPaletteSchema,
  typography: TypographySchema,
  logoSpec: LogoSpecSchema,
  createdAt: z.string(),
  version: z.number().default(1),
});
export type BrandBrief = z.infer<typeof BrandBriefSchema>;

export function createBrandBrief(opts: Omit<BrandBrief, "createdAt" | "version">): BrandBrief {
  return BrandBriefSchema.parse({
    ...opts,
    createdAt: new Date().toISOString(),
    version: 1,
  });
}
