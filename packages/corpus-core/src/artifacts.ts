export const artifactKeys = {
  sessionArtifact: (sessionId: string, filename: string) => `artifacts/sessions/${sessionId}/${filename}`,
  runtimeArtifact: (runtimeId: string, filename: string) => `artifacts/runtimes/${runtimeId}/${filename}`,
} as const;
