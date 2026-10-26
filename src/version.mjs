import { readFileSync } from "node:fs";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const BUILD_NUMBER = VERSION.split(".").reduce((value, part) => value * 100 + Number(part), 0);
