import { readFileSync } from "node:fs";
import { join } from "node:path";
export const fx = (p: string) => readFileSync(join(__dirname, "..", "fixtures", p), "utf8");
export const radicale = (name: string) => fx(`radicale-3.9.2/${name}`);
