import { ConflictException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AiEvaluationController } from './ai-evaluation.controller.js';
import { AiEvaluationService } from './ai-evaluation.service.js';
import { KnowledgeRetrievalBenchmarkService } from './knowledge-retrieval-benchmark.service.js';

const DATASET_ID = '10000000-0000-4000-8000-000000000001';
const VERSION_ID = '10000000-0000-4000-8000-000000000002';
const RUNNER_ID = '10000000-0000-4000-8000-000000000003';
const RUN_ID = '10000000-0000-4000-8000-000000000004';
const HASH = 'a'.repeat(64);

describe('AiEvaluationController', () => {
  let app: INestApplication;
  const service = {
    listDatasets: vi.fn(),
    createDataset: vi.fn(),
    createDatasetVersion: vi.fn(),
    listDatasetVersions: vi.fn(),
    getDatasetVersion: vi.fn(),
    transitionDatasetVersion: vi.fn(),
    createCase: vi.fn(),
    listCases: vi.fn(),
    annotateCase: vi.fn(),
    createRun: vi.fn(),
    listRuns: vi.fn(),
    createRunner: vi.fn(),
    listRunners: vi.fn(),
    getRun: vi.fn(),
    startRun: vi.fn(),
    submitRun: vi.fn(),
    verifyRun: vi.fn(),
    ingestBadCase: vi.fn(),
    listBadCases: vi.fn(),
    triageBadCase: vi.fn(),
    readiness: vi.fn(),
    requireReleaseReady: vi.fn(),
  };
  const retrievalBenchmarks = {
    bulkImport: vi.fn(),
    listRuns: vi.fn(),
    run: vi.fn(),
    getRun: vi.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AiEvaluationController],
      providers: [
        { provide: AiEvaluationService, useValue: service },
        { provide: KnowledgeRetrievalBenchmarkService, useValue: retrievalBenchmarks },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => app.close());

  it('creates a versioned dataset without accepting tenant or actor identity', async () => {
    service.createDataset.mockResolvedValueOnce({ id: DATASET_ID });
    const body = {
      code: 'PILOT.REGRESSION',
      name: 'Pilot regression',
      description: 'Governed enterprise AI release regression dataset.',
      idempotencyKey: 'dataset-1',
    };
    await request(app.getHttpServer())
      .post('/api/v1/admin/ai-evaluations/datasets')
      .send(body)
      .expect(201);
    expect(service.createDataset).toHaveBeenCalledWith(body);

    await request(app.getHttpServer())
      .post('/api/v1/admin/ai-evaluations/datasets')
      .send({ ...body, tenantId: DATASET_ID })
      .expect(400);
  });

  it('registers a credential-free HTTPS runner origin', async () => {
    service.createRunner.mockResolvedValueOnce({ id: RUNNER_ID });
    const body = {
      name: 'signed-sandbox-runner',
      attestationKeyFingerprint: HASH,
      allowedEvidenceOrigins: ['https://evidence.example.com/'],
      idempotencyKey: 'runner-1',
    };
    await request(app.getHttpServer())
      .post('/api/v1/admin/ai-evaluations/runners')
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/admin/ai-evaluations/runners')
      .send({
        ...body,
        idempotencyKey: 'runner-2',
        allowedEvidenceOrigins: ['https://user:secret@evidence.example.com/'],
      })
      .expect(400);
  });

  it('rejects duplicate external case results before service execution', async () => {
    const result = {
      caseId: DATASET_ID,
      judgeType: 'EXTERNAL_RUNNER',
      passed: true,
      score: 1,
      actualBehaviorHash: HASH,
      evidenceIds: [VERSION_ID],
      detail: 'Matched the signed expected behavior.',
    };
    await request(app.getHttpServer())
      .post(`/api/v1/admin/ai-evaluations/runs/${RUN_ID}/results`)
      .send({
        expectedRevision: 2,
        caseResults: [result, result],
        metrics: [
          {
            metric: 'FACTUAL_ACCURACY',
            numerator: 2,
            denominator: 2,
            value: 1,
            threshold: 0.95,
            direction: 'AT_LEAST',
            sampleCount: 2,
            minimumSampleCount: 2,
            passed: true,
            evidenceIds: [VERSION_ID],
          },
        ],
        evidenceBundleUri: 'https://evidence.example.com/bundle.json',
        evidenceBundleHash: HASH,
        runnerAttestation: 'Signed external runner attestation.',
        idempotencyKey: 'submit-1',
      })
      .expect(400);
    expect(service.submitRun).not.toHaveBeenCalled();
  });

  it('validates the release readiness subject and immutable snapshot identity', async () => {
    service.readiness.mockResolvedValueOnce({ ready: false, blockers: [] });
    await request(app.getHttpServer())
      .get(
        `/api/v1/admin/ai-evaluations/readiness?subjectType=AGENT_VERSION&subjectId=${RUNNER_ID}&subjectVersion=1&datasetVersionId=${VERSION_ID}&currentSnapshotHash=${HASH}`,
      )
      .expect(200);
    await request(app.getHttpServer())
      .get(
        `/api/v1/admin/ai-evaluations/readiness?subjectType=AGENT_VERSION&subjectId=${RUNNER_ID}&subjectVersion=0&datasetVersionId=${VERSION_ID}&currentSnapshotHash=${HASH}`,
      )
      .expect(400);
  });

  it('exposes a fail-closed assertion endpoint for publication paths', async () => {
    service.requireReleaseReady.mockRejectedValueOnce(new ConflictException('blocked'));
    await request(app.getHttpServer())
      .post('/api/v1/admin/ai-evaluations/readiness/assert')
      .send({
        subjectType: 'AGENT_VERSION',
        subjectId: RUNNER_ID,
        subjectVersion: 1,
        datasetVersionId: VERSION_ID,
        currentSnapshotHash: HASH,
      })
      .expect(409);
  });

  it('requires and forwards an exact server-side subject filter for passing Runs', async () => {
    service.listRuns.mockResolvedValueOnce({ items: [], nextCursor: null });
    await request(app.getHttpServer())
      .get(
        `/api/v1/admin/ai-evaluations/runs?subjectType=AGENT_VERSION&subjectId=${RUNNER_ID}&subjectVersion=3&status=PASSED&limit=100`,
      )
      .expect(200);
    expect(service.listRuns).toHaveBeenCalledWith({
      subjectType: 'AGENT_VERSION',
      subjectId: RUNNER_ID,
      subjectVersion: 3,
      status: 'PASSED',
      limit: 100,
    });

    await request(app.getHttpServer())
      .get('/api/v1/admin/ai-evaluations/runs?subjectType=AGENT_VERSION&limit=100')
      .expect(400);
  });

  it('exposes dataset version, case and active Runner lists', async () => {
    service.listDatasetVersions.mockResolvedValueOnce({ items: [], nextCursor: null });
    service.listCases.mockResolvedValueOnce({ items: [], nextCursor: null });
    service.listRunners.mockResolvedValueOnce({ items: [], nextCursor: null });
    await request(app.getHttpServer())
      .get(`/api/v1/admin/ai-evaluations/datasets/${DATASET_ID}/versions?limit=50`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/admin/ai-evaluations/dataset-versions/${VERSION_ID}/cases?limit=50`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/admin/ai-evaluations/runners?limit=50')
      .expect(200);
  });
});
