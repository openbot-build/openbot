# Research papers

This folder holds complete papers on agent systems. Use this guide to change a
paper, add evidence, or extend the collection. Start with the
[reading index](index.pdf) and its [source](index.typ).

The current papers present methods, design analysis, proofs under stated
assumptions, worked examples, and plans for evaluation. Planned studies are not
measured results. Keep that distinction when the papers grow.

## Files and ownership

Each numbered folder has three main files:

| File             | Use                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `main.typ`       | Complete paper source, including its abstract, models, methods, examples, limits, and conclusions. |
| `references.bib` | External references used by that paper.                                                            |
| `paper.pdf`      | PDF built from the current source and references.                                                  |

At this level, `index.typ` holds the reading list and topic boundaries.
`index.pdf` is its built form. [build.sh](build.sh) builds each numbered folder,
then the index. Keep the source and PDF together in each change.

A paper must build with its own folder as the Typst root. Put any needed figures
or data inside that folder. Do not depend on another paper's files, a temporary
folder, an author's machine, or a private source checkout.

## Topic boundaries

Shared background is useful. Repeated main claims are not. This map states the
main question of each paper and the nearby topic that it leaves to another one.

| Folder                                                              | Main question                                                            | Nearby boundary                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [01-durable-execution](01-durable-execution/main.typ)               | How does work recover when an outside result is unknown?                 | Program replay belongs to 08; task completion belongs to 04.      |
| [02-authority-preservation](02-authority-preservation/main.typ)     | How do identity and current rights bound a delegated action?             | Uncertain policy decisions belong to 03.                          |
| [03-layered-authorization](03-layered-authorization/main.typ)       | How do exact checks, model judgments, and human review share a decision? | Rights across identities belong to 02.                            |
| [04-async-agent-coordination](04-async-agent-coordination/main.typ) | When can a task close while messages and other work remain in flight?    | Recovery of one execution belongs to 01.                          |
| [05-evidence-based-memory](05-evidence-based-memory/main.typ)       | When is learned memory supported and useful?                             | Who may read it belongs to 06.                                    |
| [06-memory-information-flow](06-memory-information-flow/main.typ)   | How does source access limit derived memory?                             | Truth and usefulness belong to 05.                                |
| [07-context-compaction](07-context-compaction/main.typ)             | How can a smaller context preserve required links?                       | Long-term memory quality belongs to 05.                           |
| [08-replayable-tool-programs](08-replayable-tool-programs/main.typ) | How can a tool program resume through recorded results?                  | Durable outside effects belong to 01; secret values belong to 09. |
| [09-secret-references](09-secret-references/main.typ)               | How can a program use a secret without reading its value?                | General action rights belong to 02.                               |
| [10-open-tool-discovery](10-open-tool-discovery/main.typ)           | How does publisher evidence support discovery and withdrawal?            | Protocol behavior testing belongs to 11.                          |
| [11-protocol-conformance](11-protocol-conformance/main.typ)         | How can generated state traces find protocol faults?                     | Finding candidate tools belongs to 10.                            |
| [12-budget-scheduling](12-budget-scheduling/main.typ)               | How can work share limits when usage receipts arrive late?               | Placement by environment features belongs to 14.                  |
| [13-live-history-consistency](13-live-history-consistency/main.typ) | Which interrupted voice output may enter committed history?              | General task closure belongs to 04.                               |
| [14-compute-portability](14-compute-portability/main.typ)           | Which environment and conversions meet a task's needs?                   | Budget admission belongs to 12.                                   |
| [15-composable-runtime](15-composable-runtime/main.typ)             | Which rules survive ordered plugin composition?                          | Whole-program replay belongs to 08.                               |

Before adding a paper, state its question, main result, and excluded topics.
Compare those three items with this map. Extend an existing paper when only the
example, provider, or setting changes. A new paper needs a separate
contribution.

## Writing rules

Write in Basic English. Use short sentences and explain technical terms when
first used. Keep the technical detail needed to check the argument.

Use `OpenBot` as the author. In each manuscript it appears only in the author
field. Do not cite the OpenBot project in the body, abstract, figures, notes, or
bibliography. Do not use its paths, commit IDs, test names, architecture pages,
or release state as evidence. Check the rendered PDF as well as the source.

Make the paper stand alone. State the data model, state changes, algorithms,
assumptions, and examples directly. A reader must be able to follow the argument
without access to the project. Renaming an implementation as an "inspected
system" does not meet this rule.

When replacing a source-based claim, define an abstract method or baseline. A
baseline is a comparison method with explicit rules. State what it checks, what
it omits, and how it changes state. Then derive the example from those rules. Do
not turn an observation about code into an unsupported claim about a deployed
system.

Separate these forms of evidence:

- A definition states the method being studied.
- A proof establishes a result under named assumptions.
- A worked example derives an outcome from stated inputs and rules.
- A synthetic fixture is a made-up test case with repeatable inputs and expected
  outputs. It is not a test result until someone runs it.
- An evaluation plan states a study to run. It has no measured findings yet.
- An empirical result reports an actual run with its method, data, and limits.

Cite external primary sources: original papers, standards, and official
technical documents. Check author, title, year, version, DOI or URL, and the
claim supported by each citation. Mark drafts and experimental proposals as
such. A proposal hosted by a standards group is not necessarily an accepted
standard. Use local citation keys within each paper; each cited key must exist
in that paper's bibliography. State which parts are known methods and what the
new contribution adds. Renaming a known method does not make it new.

## Lessons from the first review

These are proof conditions to preserve when extending the methods. Read the full
paper before changing one of its rules.

| Papers | Lesson                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01, 02 | A missing reply does not prove that an outside effect failed. A local ownership fence or send permit does not cancel a request already accepted elsewhere. Define the exact event covered by the claim.                              |
| 02     | A policy checked for one principal may select different resources for its recipient. State the binding and state assumptions. Version checks need all relevant dependencies and an atomic admission step.                            |
| 03     | A deny below its decision threshold must not fall through to allow. The corrected procedure sends every remaining deny label to review. Check prose, equations, pseudocode, and proof together.                                      |
| 04, 07 | A revision check works only if all writers follow the stated atomic update rule. Reading a revision and later writing stale state is not enough.                                                                                     |
| 05, 06 | A valid source ID is not proof of support. Combining source tags is not proof that every reader may see every source. Derive memory quality and access claims separately.                                                            |
| 07     | A cut that preserves links does not by itself prove provider ordering, semantic recall, or fit within a token budget. State each claim separately.                                                                                   |
| 08, 09 | Record the full input and its stable meaning. Replay needs issue and delivery order, complete frames, and a check at return. Secret redaction covers only its defined forms; short encodings and partial output need explicit cases. |
| 10     | A bound on successful check duration does not ensure that a successful check occurs. Withdrawal liveness needs a fresh successful read and an accepted commit within the stated limits.                                              |
| 11     | Every required test state must be reachable. Two write keys cannot reach a two-note capacity error when repeated keys return old results. The fixture needs a third key and an explicit trace.                                       |
| 12     | The stated deficit fairness result needs zero starting balances, fixed weights, continuous queueing and eligibility, no corrections, clipping, or resets, and a nonbinding ceiling. Keep the bound on one request in the premises.   |
| 13     | A playback receipt reports device rendering, not human understanding. Distinguish generated, sent, rendered, and committed output.                                                                                                   |
| 14     | An effect limit must cover every finite trace prefix, including failure, cancellation, conversion, and cleanup. Successful runs alone are not enough.                                                                                |
| 15     | Ordered merge may be associative without being commutative. Hooks that are safe to repeat alone may not be safe to repeat as a chain. Resource scope types alone do not prove that nothing escapes.                                  |

When a review finds a counterexample, fix the algorithm and its explanation in
the same change. Add the smallest input trace that shows why the correction is
needed. Have a second reader check the correction against the original finding.

## Parallel writing and review

1. Define topic boundaries before assigning drafts. Give each author one folder
   and a concrete question, contribution, and evidence standard.
2. Give all authors the same template version, language rules, author string,
   citation rules, and rule against project references.
3. Keep shared files under one owner. Authors edit their own `main.typ` and
   `references.bib`; the collection owner updates the index and build script.
4. Ask each author for a complete draft, a full reread, and a list of unresolved
   concerns. Review a stable draft. A file read during replacement can be empty
   or incomplete.
5. Use separate reviewers for content and proof checks. Check assumptions,
   counterexamples, citation support, overlapping claims, and whether planned
   studies are clearly labeled.
6. Compile after the last accepted edit. A successful earlier build does not
   validate a later change. Rebuild affected PDFs after review fixes.

Keep working logs and scratch experiments outside the paper folders. If a future
result depends on a script or data file, make that artifact a maintained,
versioned part of the paper instead of leaving it in a temporary location.

## Typst setup and build

The collection uses
[charged-ieee 0.1.4](https://typst.app/universe/package/charged-ieee). The full
set was checked with Typst 0.15.1 and the TeX Gyre Termes and TeX Gyre Cursor
fonts. Keep the template version pinned. Treat a compiler, template, or font
change as a layout change and check the full collection afterward.

The paper header uses this form:

```typst
#import "@preview/charged-ieee:0.1.4": ieee
#show: ieee.with(
  title: [Paper title],
  authors: ((name: "OpenBot"),),
  abstract: [State the problem, method, result, and limits.],
  index-terms: ([Agent systems], [Research method]),
  bibliography: bibliography("references.bib"),
  figure-supplement: [Figure],
)
#set text(lang: "en")
#show raw.where(block: true): set text(size: 7pt)
```

Keep the author name as a string, `"OpenBot"`. A content value such as
`[OpenBot]` caused a metadata type error with the checked template and compiler.
The header is only a starting point; replace the example text before writing a
paper.

Install Typst and both fonts in the development environment. The first build may
need access to the package registry if the pinned template is not cached. Run
commands from the repository root, always through `devenv shell --`:

```sh
devenv shell -- typst --version
devenv shell -- typst fonts
devenv shell -- bash papers/build.sh
```

The script uses `typst` from `PATH`, or the binary named by `PAPERS_TYPST`. It
passes extra arguments to each compile call. For fonts in a separate folder,
replace the example path below with the real font folder:

```sh
devenv shell -- bash papers/build.sh --font-path /path/to/fonts
```

`TYPST_FONT_PATHS` can also supply font search paths. Keep machine-specific
paths out of the sources and build script. A Nix store path from one session is
not a portable installation instruction.

For a change to one paper, this command builds only that paper:

```sh
devenv shell -- typst compile \
  --root papers/03-layered-authorization \
  papers/03-layered-authorization/main.typ \
  papers/03-layered-authorization/paper.pdf
```

Use the same fonts and compiler for single-paper and full builds. A bibliography
change also requires a rebuild.

## Checks before delivery

Check the source first. Search manuscript and bibliography files for project
references. Each manuscript should have one author-name match; its bibliography
should have none. This search is a review aid, not a complete proof:

```sh
devenv shell -- rg -n -i \
  'openbot|packages/|working.tree|inspected (code|source|repository)|implementation evidence' \
  papers --glob main.typ --glob references.bib
```

Read the argument as well. A generic phrase can still hide a dependency on
unstated code. External standard URLs may contain source-file suffixes; judge
the source and claim rather than rejecting every such suffix.

Check the PDFs after compilation. With Poppler tools installed, these commands
show metadata and the extracted text of one paper:

```sh
devenv shell -- pdfinfo papers/03-layered-authorization/paper.pdf
devenv shell -- pdftotext papers/03-layered-authorization/paper.pdf -
```

Repeat the checks for every changed paper. Confirm the author in both metadata
and page text. Read the PDF to find clipped tables, wide equations, poor column
breaks, unreadable code, missing glyphs, and reference problems. Compilation
alone cannot find all of these. Render changed pages as images when needed.

During the first review, a word-box scan helped find text beyond the page
margins or across the column gap. Such a scan only flags possible problems;
titles and wide figures can be valid. A long inline type can cross into the next
column even when no single extracted word crosses the gap. Check whole text runs
and view the page. Put long signatures in a code block with explicit line breaks
within one column. Do not reduce text size merely to hit a page count.

Before handing off a change:

- Check each claim against its exact assumptions and cited source.
- Check that every cited key resolves and that references support the text.
- Check that examples follow the final algorithms and that test states are
  reachable.
- Check that every paper has a current PDF and builds with its own folder root.
- Check index links, titles, counts, and the topic map.
- Keep plans, derived examples, and measured results clearly separate.
- Record the compiler and font setup used, plus any failed checks, in the work
  report. Do not make a temporary failure a permanent claim in the paper.

Follow the repository checks as well:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
```

Run `devenv shell -- pnpm --filter <package> test` for each changed code
package. A paper-only change has no changed code package. Report paper
compilation and repository checks separately. If a repository check fails, keep
the actual error and state the failure; do not present a successful PDF build as
a successful application build.

Entering `devenv shell` can run the repository formatter. Check the working diff
and preserve unrelated work, especially when other authors are active.

## Adding evidence or a new paper

For a real experiment, save the runnable method, data source, versions, seeds,
settings, and raw results. State the observation window, failed runs,
uncertainty, and limits. Compare methods under the same resources and access
rules. Replace planned-result language only for experiments actually performed.

For a new topic, choose the next unused two-digit prefix and a short folder
name, such as `16-new-topic`. The current build script finds folders matching
`[0-9][0-9]-*`; every matching folder must be buildable. Do not leave an empty
draft folder in that set. The script does not infer the reading index or check
for duplicate topic IDs.

Add the source, bibliography, and PDF. Update this topic map and the index's
links, paper count, and research boundaries. Keep existing numbers and links
stable. If the naming scheme ever needs more than two digits, change the build
pattern and index together. Review overlap, build the full collection, and check
all index links before delivery.
