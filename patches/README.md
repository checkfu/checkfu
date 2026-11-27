# Domain verification patch

The frozen dependency install applies this patch to the pinned build of `@alchemy.run/domain`. It enables the existing solver feasibility check at the start of aggregate and model exploration, as used by `Prove`. The solver can discard branches it proves unreachable and retains branches whose feasibility is unknown. The verification assertions, exploration bounds and fault obligations are unchanged.

Remove the patch and its manifest and lockfile entries when the pinned build sets the check in `Explore`. Update the dependency patch guard in the setup action at the same time.
