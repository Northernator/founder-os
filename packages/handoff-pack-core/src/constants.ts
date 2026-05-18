// @founder-os/handoff-pack-core/constants -- PDF + brand + layout defaults.
//
// Re-exports a focused subset of the index.ts public constants so callers
// that only need defaults (e.g. the desktop HandoffPackTab rendering "A4 /
// 18mm / Inter" before any brand has been extracted) can import without
// pulling in the full schema surface. Mirrors the
// @founder-os/backend-core/constants and @founder-os/social-core/constants
// convention.

export {
  HANDOFF_PACK_DIR_NAME,
  HANDOFF_PACK_BRAND_DIR_NAME,
  HANDOFF_PACK_ROLE_PACKS_DIR_NAME,
  HANDOFF_PACK_INDEX_FILE_NAME,
  HANDOFF_PACK_CHECKPOINT_FILE_NAME,
  CATEGORY_SLOTS,
  CATEGORY_DIR_NAMES,
  DEFAULT_PAGE_SIZE,
  DEFAULT_PAGE_MARGINS_MM,
  DEFAULT_HEADER_HEIGHT_MM,
  DEFAULT_FOOTER_HEIGHT_MM,
  DEFAULT_HEADING_FONT,
  DEFAULT_BODY_FONT,
  DEFAULT_MONO_FONT,
  DEFAULT_FALLBACK_PRIMARY_HEX,
  DEFAULT_FALLBACK_SECONDARY_HEX,
  DEFAULT_FALLBACK_BACKGROUND_HEX,
  DEFAULT_FALLBACK_TEXT_HEX,
  DEFAULT_LOGO_PNG_SIZE_PX,
  DEFAULT_ROLE_PACK_NAMES,
} from "./index.js";
