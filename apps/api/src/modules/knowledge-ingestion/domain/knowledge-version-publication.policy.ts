export function shouldPromoteKnowledgeVersion(input: {
  readonly currentVersionId: string | null;
  readonly currentVersionNumber: number;
  readonly candidateVersionNumber: number;
}): boolean {
  return (
    input.currentVersionId === null || input.currentVersionNumber < input.candidateVersionNumber
  );
}
