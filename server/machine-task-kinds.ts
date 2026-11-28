export const TASK_KINDS = ["tests", "e2e_tests", "build", "mobile_build", "docker", "video", "local_model", "browsers", "large_files", "more_bots"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
