import fs from 'node:fs';
import path from 'node:path';
import { normalizeSignals, sha256Text } from './vone_ecosystem_radar';

interface SourceDef { id: string; vendor: string; kind: string; url: string; }
interface SourcesFile { protocol: string; sources: SourceDef[]; }

const root = process.cwd();
const configPath = path.join(root, 'src', 'ops', 'vone_ecosystem_sources.json');
const baselinePath = path.join(root, 'src', 'ops', 'vone_ecosystem_baseline.json');
const outputDir = process.env.VONE_RADAR_OUTPUT_DIR
  ? path.resolve(process.env.VONE_RADAR_OUTPUT_DIR)
  : path.join(root, 'artifacts', 'ecosystem-radar');

function htmlToText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ');
}

function pushMatches(out: string[], text: string, patterns: RegExp[]): void {
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) out.push(...matches);
  }
}

function extractSignals(source: SourceDef, raw: string): string[] {
  const signals: string[] = [];

  if (source.kind === 'github-release') {
    try {
      const release = JSON.parse(raw) as Record<string, unknown>;
      for (const key of ['tag_name','name','published_at','created_at'] as const) {
        const value = release[key];
        if (typeof value === 'string' && value.trim()) signals.push(value.trim());
      }
      const body = typeof release.body === 'string' ? release.body : '';
      pushMatches(signals, body, [
        /\bgpt-[a-z0-9._-]+\b/gi,
        /\bclaude[- ][a-z0-9._-]+\b/gi,
        /\bcodex(?:[- ][a-z0-9._-]+)?\b/gi,
        /\bllama(?:[- ]?\d+(?:\.\d+)?)?\b/gi,
        /\bmcp(?:[- ]?\d{4}-\d{2}-\d{2})?\b/gi,
        /\bqwen[a-z0-9._:-]*\b/gi,
        /\bglm[a-z0-9._:-]*\b/gi,
      ]);
      return normalizeSignals(signals).slice(0, 250);
    } catch {
      // Fall through to text extraction.
    }
  }

  const text = htmlToText(raw);
  const common = [
    /\b20\d{2}-\d{2}-\d{2}\b/g,
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}\b/gi,
  ];

  if (source.vendor === 'openai') {
    pushMatches(signals, text, [
      ...common,
      /\bgpt-[a-z0-9._-]+\b/gi,
      /\bGPT-\d+(?:\.\d+)?(?:[- ][a-z0-9._-]+)?\b/gi,
      /\bcodex(?:[- ][a-z0-9._-]+)?\b/gi,
      /\bCodex(?:[- ][a-z0-9._-]+)?\b/gi,
      /\bResponses API\b/gi,
      /\bAgents API\b/gi,
    ]);
  } else if (source.vendor === 'anthropic') {
    pushMatches(signals, text, [
      ...common,
      /\bclaude[- ][a-z0-9._-]+\b/gi,
      /\bClaude\s+(?:Opus|Sonnet|Haiku)[a-z0-9 ._-]*/gi,
      /\bOpus\s+\d+(?:\.\d+)?\b/gi,
      /\bSonnet\s+\d+(?:\.\d+)?\b/gi,
      /\bHaiku\s+\d+(?:\.\d+)?\b/gi,
      /\bClaude Code\b/gi,
    ]);
  } else if (source.vendor === 'ollama') {
    pushMatches(signals, text, [
      ...common,
      /\bollama\s+v?\d+(?:\.\d+){1,2}\b/gi,
      /\bv\d+(?:\.\d+){1,2}\b/g,
      /\bqwen[a-z0-9._:-]*\b/gi,
      /\bglm[a-z0-9._:-]*\b/gi,
      /\bgpt-oss[a-z0-9._:-]*\b/gi,
      /\bllama[a-z0-9._:-]*\b/gi,
    ]);
  } else if (source.vendor === 'github-copilot') {
    pushMatches(signals, text, [
      ...common,
      /\bGitHub Copilot\b/gi,
      /\bCopilot (?:CLI|app|code review|coding agent|agent mode|workspace)[a-z0-9 .:_-]*/gi,
      /\bVS Code[^.]{0,100}\b/gi,
    ]);
  } else if (source.vendor === 'mcp') {
    pushMatches(signals, text, [
      /\b20\d{2}-\d{2}-\d{2}\b/g,
      /\bMCP(?:\s+Specification)?\s+20\d{2}-\d{2}-\d{2}\b/gi,
      /\bSEP-\d+\b/g,
      /\bserver\/discover\b/gi,
      /\bMcp-[A-Za-z-]+\b/g,
      /\bstateless\b/gi,
      /\bextensions?\b/gi,
    ]);
  } else if (source.vendor === 'meta-llama') {
    pushMatches(signals, text, [
      /\bLlama\s+\d+(?:\.\d+)?\b/gi,
      /\bMeta Llama\s+\d+(?:\.\d+)?\b/gi,
      /\bLLaMA\s+\d+(?:\.\d+)?\b/g,
    ]);
  } else {
    pushMatches(signals, text, common);
  }

  return normalizeSignals(signals).slice(0, 250);
}

function readBaseline(): Record<string, { fingerprint: string }> {
  if (!fs.existsSync(baselinePath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    return raw.sources ?? {};
  } catch {
    return {};
  }
}

async function scanSource(source: SourceDef) {
  const response = await fetch(source.url, {
    headers: {
      'user-agent': 'V-ONE-Ecosystem-Radar/1.0',
      'accept': 'text/html,application/json;q=0.9,*/*;q=0.8'
    },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    return { id:source.id,vendor:source.vendor,kind:source.kind,url:source.url,ok:false,status:response.status,fingerprint:null,signals:[] as string[] };
  }
  const text = await response.text();
  const signals = extractSignals(source, text);
  const fingerprint = sha256Text(signals.join('\n'));
  return {
    id:source.id,vendor:source.vendor,kind:source.kind,url:source.url,ok:true,status:response.status,
    etag:response.headers.get('etag'),last_modified:response.headers.get('last-modified'),fingerprint,signals
  };
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as SourcesFile;
  const baseline = readBaseline();
  const results: Awaited<ReturnType<typeof scanSource>>[] = [];

  for (const source of config.sources) {
    try {
      results.push(await scanSource(source));
    } catch (error) {
      results.push({
        id:source.id,vendor:source.vendor,kind:source.kind,url:source.url,ok:false,status:0,
        fingerprint:null,signals:[],
        ...({ error: error instanceof Error ? error.message : String(error) } as Record<string, unknown>)
      } as Awaited<ReturnType<typeof scanSource>>);
    }
  }

  const changed = results.filter((item) =>
    item.ok && item.fingerprint && baseline[item.id]?.fingerprint !== item.fingerprint
  );
  const failed = results.filter((item) => !item.ok);

  const report = {
    protocol:'VONE_ECOSYSTEM_RADAR_R1',
    generated_at:new Date().toISOString(),
    source_count:results.length,
    changed_count:changed.length,
    failed_count:failed.length,
    changed_source_ids:changed.map((item)=>item.id),
    failed_source_ids:failed.map((item)=>item.id),
    sources:results,
    gates:{
      auto_apply_to_production:false,
      paid_blocked:'INVIOLABLE',
      unknown_cost:'HOLD',
      security_regression:'HOLD',
      breaking_change:'HOLD',
      candidate_path:'SANDBOX_EVAL_THEN_PROMOTE'
    }
  };

  fs.mkdirSync(outputDir,{recursive:true});
  fs.writeFileSync(path.join(outputDir,'report.json'),JSON.stringify(report,null,2));

  const nextBaseline = {
    protocol:'VONE_ECOSYSTEM_RADAR_BASELINE_R1',
    updated_at:report.generated_at,
    sources:Object.fromEntries(results.filter((item)=>item.ok&&item.fingerprint).map((item)=>[
      item.id,{fingerprint:item.fingerprint,vendor:item.vendor,kind:item.kind,signals:item.signals}
    ]))
  };
  fs.writeFileSync(path.join(outputDir,'next-baseline.json'),JSON.stringify(nextBaseline,null,2));

  console.log(JSON.stringify({
    protocol:report.protocol,
    generated_at:report.generated_at,
    source_count:report.source_count,
    changed_count:report.changed_count,
    failed_count:report.failed_count,
    changed_source_ids:report.changed_source_ids,
    failed_source_ids:report.failed_source_ids
  }));

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,`changed=${changed.length>0}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT,`failed=${failed.length}\n`);
  }
}

main().catch((error)=>{ console.error(error); process.exitCode=1; });
