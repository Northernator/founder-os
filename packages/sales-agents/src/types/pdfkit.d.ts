// Ambient module shim. pdfkit ships no types and is an OPTIONAL peer
// dependency, so we don't pull in the (large) @types/pdfkit dependency
// for the whole workspace. The two PDF-generation files import pdfkit
// dynamically (require/await import) and treat the result as `any` --
// this declaration is just to satisfy `tsc --strict` so the package
// typechecks without @types/pdfkit installed.
//
// If we ever want richer pdfkit typings, add @types/pdfkit to devDependencies
// and delete this file.
declare module "pdfkit";
