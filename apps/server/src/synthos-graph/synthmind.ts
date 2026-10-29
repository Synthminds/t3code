// @effect-diagnostics-next-line nodeBuiltinImport:off -- The pinned graph engine runs under its supported Node version in a separate process.
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Schema from "effect/Schema";
import { SynthosGraphError, type SynthosGraphCommand } from "@t3tools/contracts";
import { exploreGraph, type scopedGraph } from "./graph.ts";
const PIN = "3e3ca9e039d3015d2dbdcd76ee4d3e5d61287b07";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ nodes: Schema.Array(Schema.String), edges: Schema.Array(Schema.String) }),
  ),
);
const bridge = String.raw`
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=process.argv[1];
const {federate}=await import(pathToFileURL(root+'/src/projection.ts').href);
const {findPath,neighborhood}=await import(pathToFileURL(root+'/src/network.ts').href);
const {qualifyId}=await import(pathToFileURL(root+'/src/identity.ts').href);
const {graph,command}=JSON.parse(readFileSync(0,'utf8'));
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const assertions=graph.edges.flatMap(e=>[
  {...e,id:JSON.stringify([e.id,0]),originalId:e.id},
  ...(e.directed===false && e.source!==e.target ? [{...e,id:JSON.stringify([e.id,1]),originalId:e.id,source:e.target,target:e.source}] : [])
]);
const originalEdgeIds=new Map(assertions.map(e=>[e.id,e.originalId]));
const document={schemaVersion:1,graphId:'synthos',version:'1.0.0',domainId:'project',visibility:'private',layers:[{id:'approved',label:'Approved project scope'}],ontology:{nodeTypes:['evidence'],predicates:[...new Set(graph.edges.map(e=>e.predicate))].map(id=>({id,sourceTypes:['evidence'],targetTypes:['evidence']}))},evidence:graph.nodes.map(n=>({id:n.id,source:n.ref,sha256:hash(n)})),nodes:graph.nodes.map(n=>({id:n.id,type:'evidence',layers:['approved'],label:n.label,evidenceRefs:[n.id]})),edges:assertions.map(e=>({id:e.id,source:e.source,target:e.target,predicate:e.predicate,directed:true,layers:['approved'],evidenceRefs:[...new Set([e.source,e.target])]}))};
const projection=federate([document],[{graphId:'synthos',layers:['approved']}]);
let result=projection;
if(command.focusId){
  const focus=qualifyId('synthos','node',command.focusId);
  if(command.targetId){
    const target=qualifyId('synthos','node',command.targetId);
    result=findPath(projection,command.direction==='incoming'?target:focus,command.direction==='incoming'?focus:target,{direction:!command.direction || command.direction==='both'?'weak':'directed',maxDepth:4});
  }else{
    let ids=new Set([focus]);
    for(let i=0;i<(command.hops??1);i++)for(const id of [...ids])for(const n of neighborhood(projection,id,command.direction??'both').nodes)ids.add(n.id);
    result={nodes:projection.nodes.filter(n=>ids.has(n.id)),edges:projection.edges.filter(e=>ids.has(e.source)&&ids.has(e.target))};
  }
}
process.stdout.write(JSON.stringify({nodes:result.nodes.map(n=>n.sourceId),edges:[...new Set(result.edges.map(e=>originalEdgeIds.get(e.sourceId)))]}));
`;
const run = Effect.fn("SynthosGraph.engineProcess")(function* (
  binary: string,
  args: readonly string[],
  stdin = "",
) {
  return yield* Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        const child = NodeChildProcess.execFile(
          binary,
          [...args],
          { timeout: 15000, maxBuffer: 2_000_000, signal },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
        child.stdin?.on("error", reject);
        if (stdin.length > 0) child.stdin?.end(stdin);
        else child.stdin?.end();
      }),
    catch: (cause) => new SynthosGraphError({ reason: "unavailable", cause }),
  });
});
export const exploreWithEngine = Effect.fn("SynthosGraph.exploreWithEngine")(function* (
  graph: ReturnType<typeof scopedGraph>,
  command: Extract<SynthosGraphCommand, { type: "explore" }>,
) {
  const env = yield* HostProcess.Environment;
  const root = env.SYNTHMIND_ROOT;
  const bounded = exploreGraph(graph, command);
  if (!root) return bounded;
  const node = env.SYNTHMIND_NODE;
  if (
    !node ||
    (yield* run("git", ["-C", root, "rev-parse", "HEAD"])).trim() !== PIN ||
    (yield* run("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"])).trim()
  )
    return yield* new SynthosGraphError({ reason: "unavailable" });
  if ((yield* run(node, ["--version"])).trim() !== "v22.23.1")
    return yield* new SynthosGraphError({ reason: "unavailable" });
  if (!bounded.nodes.length) return bounded;
  const result = yield* run(
    node,
    ["--experimental-strip-types", "--input-type=module", "--eval", bridge, root],
    encode({ graph: bounded, command }),
  ).pipe(
    Effect.flatMap(decode),
    Effect.mapError((cause) => new SynthosGraphError({ reason: "unavailable", cause })),
  );
  const ids = new Set(result.nodes);
  const edges = new Set(result.edges);
  return {
    ...bounded,
    nodes: bounded.nodes.filter((n) => ids.has(n.id)),
    edges: bounded.edges.filter((e) => edges.has(e.id)),
  };
});
