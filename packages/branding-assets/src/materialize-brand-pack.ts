import { z } from "zod";
import type { BrandBrief } from "@founder-os/branding-core";

export const BrandPackManifestSchema = z.object({
  ventureId: z.string(),
  ventureSlug: z.string(),
  files: z.array(
    z.object({
      filename: z.string(),
      role: z.enum([
        "logo_svg",
        "logo_dark_svg",
        "logo_icon_svg",
        "tokens_json",
        "tailwind_preset",
        "readme",
      ]),
      relativePath: z.string(),
    })
  ),
  createdAt: z.string(),
});
export type BrandPackManifest = z.infer<typeof BrandPackManifestSchema>;

/** Generate the SVG wordmark from a brand brief */
export function generateWordmarkSvg(brief: BrandBrief): string {
  const { companyName, colorPalette, typography } = brief;
  const width = companyName.length * 18 + 40;
  const height = 60;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${companyName} logo">
  <title>${companyName}</title>
  <rect width="${width}" height="${height}" fill="${colorPalette.background}" rx="8"/>
  <text
    x="${width / 2}"
    y="${height / 2 + 8}"
    text-anchor="middle"
    dominant-baseline="middle"
    font-family="${typography.headingFont}, Inter, sans-serif"
    font-weight="${typography.headingWeight}"
    font-size="28"
    fill="${colorPalette.primary}"
    letter-spacing="-0.5"
  >${companyName}</text>
</svg>`;
}

/** Generate the dark-mode wordmark SVG */
export function generateWordmarkDarkSvg(brief: BrandBrief): string {
  const { companyName, colorPalette, typography } = brief;
  const width = companyName.length * 18 + 40;
  const height = 60;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${companyName} logo dark">
  <title>${companyName} (dark)</title>
  <rect width="${width}" height="${height}" fill="${colorPalette.primary}" rx="8"/>
  <text
    x="${width / 2}"
    y="${height / 2 + 8}"
    text-anchor="middle"
    dominant-baseline="middle"
    font-family="${typography.headingFont}, Inter, sans-serif"
    font-weight="${typography.headingWeight}"
    font-size="28"
    fill="${colorPalette.background}"
    letter-spacing="-0.5"
  >${companyName}</text>
</svg>`;
}

/** Generate the icon mark SVG (square, just first letter or icon shape) */
export function generateIconSvg(brief: BrandBrief): string {
  const { companyName, colorPalette, typography } = brief;
  const letter = companyName[0]?.toUpperCase() ?? "?";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="${companyName} icon">
  <title>${companyName} icon</title>
  <rect width="64" height="64" fill="${colorPalette.primary}" rx="14"/>
  <text
    x="32"
    y="42"
    text-anchor="middle"
    font-family="${typography.headingFont}, Inter, sans-serif"
    font-weight="${typography.headingWeight}"
    font-size="36"
    fill="${colorPalette.background}"
  >${letter}</text>
</svg>`;
}

/** Generate design tokens JSON */
export function generateTokensJson(brief: BrandBrief): string {
  const { colorPalette, typography } = brief;
  const tokens = {
    color: {
      primary: colorPalette.primary,
      secondary: colorPalette.secondary,
      accent: colorPalette.accent,
      background: colorPalette.background,
      surface: colorPalette.surface,
      text: colorPalette.text,
      textMuted: colorPalette.textMuted,
    },
    font: {
      heading: typography.headingFont,
      body: typography.bodyFont,
      mono: typography.monoFont ?? "JetBrains Mono",
    },
    fontWeight: {
      heading: typography.headingWeight,
      body: typography.bodyWeight,
    },
    fontSize: {
      base: typography.scaleBase,
      sm: Math.round(typography.scaleBase * 0.875),
      lg: Math.round(typography.scaleBase * 1.125),
      xl: Math.round(typography.scaleBase * 1.25),
      "2xl": Math.round(typography.scaleBase * 1.5),
      "3xl": Math.round(typography.scaleBase * 1.875),
      "4xl": Math.round(typography.scaleBase * 2.25),
    },
  };
  return JSON.stringify(tokens, null, 2);
}

/** Generate a Tailwind CSS preset */
export function generateTailwindPreset(brief: BrandBrief): string {
  const { colorPalette, typography } = brief;
  return `/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      colors: {
        brand: {
          primary: "${colorPalette.primary}",
          secondary: "${colorPalette.secondary}",
          accent: "${colorPalette.accent}",
          bg: "${colorPalette.background}",
          surface: "${colorPalette.surface}",
          text: "${colorPalette.text}",
          muted: "${colorPalette.textMuted}",
        },
      },
      fontFamily: {
        heading: ["${typography.headingFont}", "Inter", "sans-serif"],
        body: ["${typography.bodyFont}", "Inter", "sans-serif"],
        mono: ["${typography.monoFont ?? "JetBrains Mono"}", "monospace"],
      },
    },
  },
};
`;
}

export type BrandPackFiles = {
  "logo.svg": string;
  "logo-dark.svg": string;
  "logo-icon.svg": string;
  "tokens.json": string;
  "tailwind-preset.js": string;
  "BRAND_README.md": string;
};

/** Materialize all brand pack files in memory — caller writes to disk */
export function materializeBrandPack(brief: BrandBrief): BrandPackFiles {
  return {
    "logo.svg": generateWordmarkSvg(brief),
    "logo-dark.svg": generateWordmarkDarkSvg(brief),
    "logo-icon.svg": generateIconSvg(brief),
    "tokens.json": generateTokensJson(brief),
    "tailwind-preset.js": generateTailwindPreset(brief),
    "BRAND_README.md": generateBrandReadme(brief),
  };
}

function generateBrandReadme(brief: BrandBrief): string {
  return `# ${brief.companyName} — Brand Pack

Generated by Founder OS on ${new Date(brief.createdAt).toLocaleDateString("en-GB")}.

## Identity
- **Tagline**: ${brief.tagline}
- **Mission**: ${brief.mission}
- **Audience**: ${brief.targetAudience}
- **Personality**: ${brief.personality.join(", ")}
- **Tone**: ${brief.toneOfVoice}

## Files
| File | Purpose |
|------|---------|
| \`logo.svg\` | Full wordmark (light backgrounds) |
| \`logo-dark.svg\` | Full wordmark (dark backgrounds) |
| \`logo-icon.svg\` | Square icon mark — use for favicons, app icons |
| \`tokens.json\` | Design tokens — import into Figma or your design system |
| \`tailwind-preset.js\` | Drop into \`tailwind.config.js\` presets array |

## Colours
| Token | Value |
|-------|-------|
| Primary | \`${brief.colorPalette.primary}\` |
| Secondary | \`${brief.colorPalette.secondary}\` |
| Accent | \`${brief.colorPalette.accent}\` |
| Background | \`${brief.colorPalette.background}\` |
| Surface | \`${brief.colorPalette.surface}\` |

## Typography
- Heading: **${brief.typography.headingFont}** (${brief.typography.headingWeight})
- Body: **${brief.typography.bodyFont}** (${brief.typography.bodyWeight})
`;
}
