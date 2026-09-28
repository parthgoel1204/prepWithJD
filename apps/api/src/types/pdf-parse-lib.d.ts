// pdf-parse ships no types for its inner parser entry, and `@types/pdf-parse`
// only declares the package root. The lib export IS the same parser (it skips
// index.js's debug-file path), so reuse the root module's types verbatim.
declare module "pdf-parse/lib/pdf-parse.js" {
  import PdfParse = require("pdf-parse");
  const parse: typeof PdfParse;
  export default parse;
}