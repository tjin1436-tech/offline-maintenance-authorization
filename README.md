# Bounded Offline Authorization and Auditable Recovery for Robot Maintenance: code and data

Code and experiment records for the article "Bounded Offline Authorization and Auditable Recovery for Robot Maintenance under Intermittent Connectivity" (J. Tian, S. Kim). Each folder is self-contained and has its own README (in Chinese) with run instructions.

| Folder | Article section | Content |
|---|---|---|
| `offline_maintenance_six_experiments` | 6.2 Functional checks | Python functional model with a simulated registry: 6 groups, 26 checks |
| `offline_maintenance_stage2` | Appendix A | Early process-failure experiment: SQLite reservation, forced gateway process termination, public keys for offline signature verification |
| `offline_maintenance_stage3_evm` | 6.3 EVM registration and the adapter boundary | Solidity registry on a local Ganache chain: 13 scenarios x 3, 39 checks |
| `offline_maintenance_stage4_comparison` | 6.7-6.9 Policy simulation | Trace-driven lifetime-policy simulation: 150 traces (seeds 1000-1029), 7,200 evaluations |
| `offline_maintenance_stage5_e2e` | Online Resource 1 | Layered HTTP prototype: four formal batches (216 runs) and diagnostic runs |
| `stage5_diagnostic_tools` | Online Resource 1 | Diagnostic tools for the long-running layered HTTP run |
| `offline_maintenance_stage6_unified` | 6.4-6.5 Unified durable prototype | Revised article: `stage6_results_r5_run2` (five repetitions: 60 fault cases, 9 functional checks, 180 performance runs, 120 s observation). `stage6_results` is the earlier three-repetition batch (36 cases, 108 runs) |
| `offline_maintenance_stage7_ablation` | 6.6 Recovery ablation | Full, late-reservation and retry-pending variants: 36 runs, 66 transactions |

Software versions: Python 3.9.13; Node.js 24.15.0; ethers 6.13.5; Ganache 7.9.2; solc 0.8.28. Node.js folders: run `npm ci` before the scripts. All keys in this repository are test keys generated for the experiments and are not used by any real wallet, robot or account.

Licence: code under the MIT Licence; experiment data under CC BY 4.0.
