# Stage 7 recovery ablation

Environment: win32 / v24.15.0; 36 runs. Audit passed means the recorded evidence is consistent.

| Scenario | Variant | Runs | Quota excess | Duplicate effects | Effects without gateway intent | Pending | First operation DONE | Execute RPC |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| no_fault | full | 3 | 0 | 0 | 0 | 0 | 3 | 3 |
| no_fault | late_reserve | 3 | 0 | 0 | 0 | 0 | 3 | 3 |
| no_fault | retry_pending | 3 | 0 | 0 | 0 | 0 | 3 | 3 |
| before_dispatch | full | 3 | 0 | 0 | 0 | 3 | 0 | 0 |
| before_dispatch | late_reserve | 3 | 0 | 0 | 0 | 0 | 0 | 3 |
| before_dispatch | retry_pending | 3 | 0 | 0 | 0 | 0 | 3 | 3 |
| after_effect | full | 3 | 0 | 0 | 0 | 0 | 3 | 3 |
| after_effect | late_reserve | 3 | 3 | 0 | 3 | 0 | 0 | 6 |
| after_effect | retry_pending | 3 | 0 | 0 | 0 | 0 | 3 | 6 |
| during_done | full | 3 | 0 | 0 | 0 | 0 | 3 | 3 |
| during_done | late_reserve | 3 | 0 | 0 | 0 | 0 | 3 | 3 |
| during_done | retry_pending | 3 | 0 | 0 | 0 | 0 | 3 | 6 |

All numeric outcomes are sums across the listed runs. Read protocol.json and README_中文.md for boundaries.
