import { icons } from "lucide";
import { writeFile } from "node:fs/promises";

const names = ["LogIn", "LogOut", "KeyRound", "Filter", "RefreshCw", "Download", "Trash2", "ChevronLeft", "ChevronRight"];
const selected = Object.fromEntries(names.map(name => [name, icons[name]]));
await writeFile(new URL("../public/icons.js", import.meta.url),
  "// Lucide icons, ISC license: https://github.com/lucide-icons/lucide/blob/main/LICENSE\nexport const icons = " + JSON.stringify(selected) + ";\n");
console.log(`Built ${names.length} Lucide icons.`);
