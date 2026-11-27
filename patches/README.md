# Dependency patches

`bun install` applies these automatically (`patchedDependencies` in `package.json`). There is nothing to run by hand.

## @alchemy.run/domain

`Verify.model` builds its own interpreter and never sets the feasibility check that the library's `Prove` functions set (`interpreter.current.feasible = Check.feasible(solver)`). Without it the model search takes every branch, including ones Z3 can rule out: `Sessions.verify` did not finish in 53 minutes, and takes about 2.5 with it.

The patch adds that one line where `Explore` creates an interpreter, in `lib/` and `src/`.

Delete this patch, and its `patchedDependencies` entry, once the pinned build of `@alchemy.run/domain` sets the check in `Explore` itself. When the pinned build changes before then, regenerate the patch with `bun patch @alchemy.run/domain`, add the same line, and run `bun patch --commit`.
