// @effect-diagnostics nodeBuiltinImport:off - generates build assets on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import sharp from "sharp";

import { DEVELOPMENT_PUBLIC_ICON_OVERRIDES, WEB_DESKTOP_ICON_ASSETS } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const generated = new Map<string, Buffer>();

for (const assets of Object.values(WEB_DESKTOP_ICON_ASSETS)) {
  const source = await NodeFSP.readFile(NodePath.join(root, assets.sourceSvg), "utf8");
  const render = (size: number) =>
    sharp(Buffer.from(source), { density: 300 }).resize(size, size).png().toBuffer();
  generated.set(assets.iconPng, await render(1024));
  generated.set(assets.appleTouchIconPng, await render(180));
  generated.set(assets.favicon16Png, await render(16));
  generated.set(assets.favicon32Png, await render(32));

  const renditions = [];
  for (const size of WINDOWS_ICON_SIZES) {
    renditions.push({ size, contents: await render(size) });
  }
  const ico = encodePngIco(renditions);
  generated.set(assets.windowsIconIco, ico);
  generated.set(assets.faviconIco, ico);

  const artwork = source.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const macSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-opacity=".22"/>
    </filter></defs>
    <g filter="url(#shadow)"><g transform="translate(100 100) scale(6.4375)">${artwork}</g></g>
  </svg>`;
  generated.set(assets.macIconPng, await sharp(Buffer.from(macSvg)).png().toBuffer());
}

for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
  generated.set(override.targetRelativePath, generated.get(override.sourceRelativePath)!);
}

const stale = [];
for (const [relative, expected] of generated) {
  const destination = NodePath.join(root, relative);
  if (check) {
    const actual = await NodeFSP.readFile(destination);
    if (!actual.equals(expected)) stale.push(relative);
  } else {
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.writeFile(destination, expected);
  }
}

if (stale.length) throw new Error(`Stale c0d3 icons:\n${stale.join("\n")}`);
process.stdout.write(
  `${check ? "Verified" : "Exported"} ${generated.size} c0d3 web and desktop icons.\n`,
);
