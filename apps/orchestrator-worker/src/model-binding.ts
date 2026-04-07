export interface ModelTextGenerationBinding {
  run<ModelInput extends Record<string, unknown>, ModelOutput = unknown>(
    model: string,
    input: ModelInput,
    options?: Record<string, unknown>,
  ): Promise<ModelOutput>;
}
