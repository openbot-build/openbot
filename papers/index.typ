#set document(title: "Research Papers on Agent Systems", author: "OpenBot")
#set page(paper: "a4", margin: 22mm, numbering: "1")
#set text(font: "TeX Gyre Termes", size: 11pt, lang: "en")
#set par(leading: 0.65em)
#set heading(numbering: none)
#align(center)[
  #text(size: 25pt, weight: "bold")[Research Papers on Agent Systems]
  #v(8pt)
  OpenBot \ October 27, 2026
]

= About this collection

These fifteen papers study distinct problems in agent systems. Each paper states its models, algorithms, assumptions, examples, and arguments directly. Each folder holds a complete Typst source file, its bibliography, and a PDF. Each paper uses #link("https://typst.app/universe/package/charged-ieee")[charged-ieee 0.1.4].

The papers state methods, proofs under named assumptions, worked examples, and measured finite experiments. Each comparison method has explicit rules. The experiments include independent checks and ablations: runs that remove one rule to show why it is needed. Each paper separates these results from larger studies that have not been run. External research and standards are cited in each bibliography. The text states which methods are established and which result this paper adds.

= Papers

#block(breakable: false)[
  *01. Durable Agent Execution with Unknown External Outcomes* \
  State, attempts, ownership, and unknown outside results. \
  #link("01-durable-execution/paper.pdf")[Read PDF] #h(10pt) #link("01-durable-execution/main.typ")[Typst source] #h(10pt) #link("01-durable-execution/references.bib")[References]
]

#block(breakable: false)[
  *02. Authority Preservation Across Multi-Principal Agent Delegation* \
  How identity and current rights bound each action. \
  #link("02-authority-preservation/paper.pdf")[Read PDF] #h(10pt) #link("02-authority-preservation/main.typ")[Typst source] #h(10pt) #link("02-authority-preservation/references.bib")[References]
]

#block(breakable: false)[
  *03. Layered Agent Authorization with Exact Grants, Cited Rules, and Escalation* \
  How exact checks and model decisions share approval work. \
  #link("03-layered-authorization/paper.pdf")[Read PDF] #h(10pt) #link("03-layered-authorization/main.typ")[Typst source] #h(10pt) #link("03-layered-authorization/references.bib")[References]
]

#block(breakable: false)[
  *04. Completion Frontiers for Long-Lived Agent Tasks* \
  How tasks progress and end while other work stays open. \
  #link("04-async-agent-coordination/paper.pdf")[Read PDF] #h(10pt) #link("04-async-agent-coordination/main.typ")[Typst source] #h(10pt) #link("04-async-agent-coordination/references.bib")[References]
]

#block(breakable: false)[
  *05. Evidence-Based Agent Memory from Self-Reported Learning Cues* \
  How learning cues lead to supported and useful memory. \
  #link("05-evidence-based-memory/paper.pdf")[Read PDF] #h(10pt) #link("05-evidence-based-memory/main.typ")[Typst source] #h(10pt) #link("05-evidence-based-memory/references.bib")[References]
]

#block(breakable: false)[
  *06. Source-Constrained Information Flow for Shared Agent Memory* \
  How source access limits derived knowledge. \
  #link("06-memory-information-flow/paper.pdf")[Read PDF] #h(10pt) #link("06-memory-information-flow/main.typ")[Typst source] #h(10pt) #link("06-memory-information-flow/references.bib")[References]
]

#block(breakable: false)[
  *07. Dependency-Preserving Context Compaction for Tool-Using Agents* \
  How context cuts keep tool and approval links whole. \
  #link("07-context-compaction/paper.pdf")[Read PDF] #h(10pt) #link("07-context-compaction/main.typ")[Typst source] #h(10pt) #link("07-context-compaction/references.bib")[References]
]

#block(breakable: false)[
  *08. Replayable Tool Programs with Human Approval Boundaries* \
  How a generated program pauses for approval and runs again. \
  #link("08-replayable-tool-programs/paper.pdf")[Read PDF] #h(10pt) #link("08-replayable-tool-programs/main.typ")[Typst source] #h(10pt) #link("08-replayable-tool-programs/references.bib")[References]
]

#block(breakable: false)[
  *09. Secret References and Controlled Egress for Agent-Written Programs* \
  How a program uses a secret without reading its value. \
  #link("09-secret-references/paper.pdf")[Read PDF] #h(10pt) #link("09-secret-references/main.typ")[Typst source] #h(10pt) #link("09-secret-references/references.bib")[References]
]

#block(breakable: false)[
  *10. Publisher-Grounded Discovery for an Open Agent Tool Web* \
  How publisher evidence supports discovery and withdrawal. \
  #link("10-open-tool-discovery/paper.pdf")[Read PDF] #h(10pt) #link("10-open-tool-discovery/main.typ")[Typst source] #h(10pt) #link("10-open-tool-discovery/references.bib")[References]
]

#block(breakable: false)[
  *11. State-Based Conformance Testing for Agent Tool Protocols* \
  How generated traces can find faults between implementations. \
  #link("11-protocol-conformance/paper.pdf")[Read PDF] #h(10pt) #link("11-protocol-conformance/main.typ")[Typst source] #h(10pt) #link("11-protocol-conformance/references.bib")[References]
]

#block(breakable: false)[
  *12. Hierarchical Agent Budgets Under Uncertain Model Usage* \
  How shared limits and delayed receipts guide admission. \
  #link("12-budget-scheduling/paper.pdf")[Read PDF] #h(10pt) #link("12-budget-scheduling/main.typ")[Typst source] #h(10pt) #link("12-budget-scheduling/references.bib")[References]
]

#block(breakable: false)[
  *13. History Consistency for Interruptible Voice Agents* \
  How output, playback, and committed history stay distinct. \
  #link("13-live-history-consistency/paper.pdf")[Read PDF] #h(10pt) #link("13-live-history-consistency/main.typ")[Typst source] #h(10pt) #link("13-live-history-consistency/references.bib")[References]
]

#block(breakable: false)[
  *14. Capability-Aware Portability of Agent Tasks Across Compute Environments* \
  How task needs match different execution environments. \
  #link("14-compute-portability/paper.pdf")[Read PDF] #h(10pt) #link("14-compute-portability/main.typ")[Typst source] #h(10pt) #link("14-compute-portability/references.bib")[References]
]

#block(breakable: false)[
  *15. Preserving Execution Constraints in a Composable Agent Runtime* \
  How ordered plugins preserve checks and resource ownership. \
  #link("15-composable-runtime/paper.pdf")[Read PDF] #h(10pt) #link("15-composable-runtime/main.typ")[Typst source] #h(10pt) #link("15-composable-runtime/references.bib")[References]
]

= Build

Install Typst and the TeX Gyre Termes and TeX Gyre Cursor fonts. From the project root, run:

```sh
devenv shell -- bash papers/build.sh
```

The build script accepts Typst options such as `--font-path`. Set `PAPERS_TYPST` to use another Typst binary. Each paper can also be built on its own by compiling its `main.typ` file. The import pins the template version. The PDFs in this collection are checked with Typst 0.15.1.

= Reproduce the finite experiments

From the collection checkout, run:

```sh
devenv shell -- python3 papers/experiments/run.py \
  --seeds 30 --output papers/experiments/results.json
```

The runner uses Python's standard library. The #link("experiments/results.json")[saved results] record the input domains, seeds, checks, observations, and limits for each paper. Source hashes cover the manuscripts, references, and experiment code. A run fails if these files change while it runs. Repeated runs should give the same model results; elapsed time and creation time can differ.

A check is one assertion, not an independent study or a user task. Exhaustive results cover only the named finite domain. Synthetic cases do not measure model quality, real network cost, or user behavior. The larger studies in each paper remain separate work. The #link("experiments/run.py")[runner] and its model modules are maintained parts of this collection.

#pagebreak(weak: true)

= Research boundaries

Paper 1 owns recovery and outside effects. Paper 2 owns rights across identities. Paper 3 owns uncertain rule decisions and approval work. Paper 4 owns task coordination and completion. Paper 5 owns memory quality, while Paper 6 owns memory access. Paper 7 owns short-term context size. Paper 8 owns generated program replay, and Paper 9 owns secret values. Paper 10 owns open discovery. Paper 11 owns conformance test methods. Papers 12 through 15 own budget admission, live history, compute fit, and runtime composition, in that order.
