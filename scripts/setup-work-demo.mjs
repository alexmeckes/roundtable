import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=await mkdtemp(join(tmpdir(),'roundtable-work-demo-'));
const source=join(root,'inputs');await mkdir(source);
await writeFile(join(source,'brief.md'),'# Shared work example\nWe are choosing a fictional internal knowledge tool for a six-person team. Prefer low cost and easy exports. All data is illustrative, not real vendor information. Use options.csv as the source of truth. Produce a decision brief and comparison CSV. Do not use external services.\n');
await writeFile(join(source,'options.csv'),'name,monthly_cost,seats,export\nAtlas,30,6,yes\nBeacon,20,6,no\nCedar,45,10,yes\n');
await writeFile(join(root,'approach.txt'),'Keep discussion concise. Ground claims in the supplied fictional brief and CSV. Do not use external services. During chat, do not modify files. During assigned work, produce only the requested deliverables in the isolated task directory.');
console.log(root);
