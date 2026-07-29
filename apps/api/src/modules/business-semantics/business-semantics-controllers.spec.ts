import 'reflect-metadata';

import { RequestMethod, type Type } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { BusinessSemanticsWorkbenchController } from './business-semantics-workbench.controller.js';
import { DeliverableAcceptanceAdminController } from './deliverable-acceptance-admin.controller.js';
import {
  EvidenceAdminController,
  EvidenceLinkAdminController,
} from './evidence-admin.controller.js';
import {
  MetricAdminController,
  MetricObservationAdminController,
} from './metric-admin.controller.js';
import {
  ObjectiveAdminController,
  ObjectiveRelationAdminController,
} from './objective-admin.controller.js';
import { ProcessAdminController } from './process-admin.controller.js';
import { StrategyAdminController } from './strategy-admin.controller.js';
import { TaskAdminController, TaskDependencyAdminController } from './task-admin.controller.js';
import { ValueAdminController } from './value-admin.controller.js';

const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

function controllerPath(controller: Type<unknown>): string {
  return Reflect.getMetadata(PATH_METADATA, controller) as string;
}

function route(
  controller: Type<unknown>,
  handler: string,
): { readonly path: string; readonly method: RequestMethod } {
  const descriptor = Object.getOwnPropertyDescriptor(controller.prototype, handler);
  if (descriptor?.value === undefined) throw new Error(`Missing handler ${handler}.`);
  return {
    path: (Reflect.getMetadata(PATH_METADATA, descriptor.value) as string | undefined) ?? '',
    method: Reflect.getMetadata(METHOD_METADATA, descriptor.value) as RequestMethod,
  };
}

describe('business semantics HTTP surface', () => {
  it.each([
    [ValueAdminController, 'admin/business-semantics/values'],
    [StrategyAdminController, 'admin/business-semantics/strategies'],
    [ObjectiveAdminController, 'admin/business-semantics/objectives'],
    [ObjectiveRelationAdminController, 'admin/business-semantics/objectives/relations'],
    [MetricAdminController, 'admin/business-semantics/metrics'],
    [MetricObservationAdminController, 'admin/business-semantics/metrics/observations'],
    [ProcessAdminController, 'admin/business-semantics/processes'],
    [TaskAdminController, 'admin/business-semantics/tasks'],
    [TaskDependencyAdminController, 'admin/business-semantics/tasks/dependencies'],
    [DeliverableAcceptanceAdminController, 'admin/business-semantics/tasks/:taskId/deliverables'],
    [EvidenceAdminController, 'admin/business-semantics/evidence'],
    [EvidenceLinkAdminController, 'admin/business-semantics/evidence/:evidenceId/links'],
    [BusinessSemanticsWorkbenchController, 'workbench'],
  ] as const)('binds %p to /api/v1/%s', (controller, expectedPath) => {
    expect(controllerPath(controller)).toBe(expectedPath);
  });

  it.each([
    [ValueAdminController, 'update', ':id', RequestMethod.PATCH],
    [ValueAdminController, 'createVersion', ':definitionId/versions', RequestMethod.POST],
    [
      ValueAdminController,
      'transitionVersion',
      ':definitionId/versions/:versionId/transition',
      RequestMethod.POST,
    ],
    [StrategyAdminController, 'transition', ':id/transition', RequestMethod.POST],
    [ObjectiveAdminController, 'transition', ':id/transition', RequestMethod.POST],
    [ObjectiveRelationAdminController, 'update', ':id', RequestMethod.PATCH],
    [MetricAdminController, 'transition', ':id/transition', RequestMethod.POST],
    [MetricObservationAdminController, 'update', ':id', RequestMethod.PATCH],
    [
      ProcessAdminController,
      'transitionVersion',
      ':definitionId/versions/:versionId/transition',
      RequestMethod.POST,
    ],
    [TaskAdminController, 'transition', ':id/transition', RequestMethod.POST],
    [TaskDependencyAdminController, 'update', ':id', RequestMethod.PATCH],
    [
      DeliverableAcceptanceAdminController,
      'createAcceptance',
      ':deliverableId/acceptances',
      RequestMethod.POST,
    ],
    [
      DeliverableAcceptanceAdminController,
      'transitionAcceptance',
      ':deliverableId/acceptances/:acceptanceId/transition',
      RequestMethod.POST,
    ],
    [EvidenceAdminController, 'transition', ':id/transition', RequestMethod.POST],
    [EvidenceLinkAdminController, 'update', ':linkId', RequestMethod.PATCH],
    [BusinessSemanticsWorkbenchController, 'listObjectives', 'objectives', RequestMethod.GET],
    [BusinessSemanticsWorkbenchController, 'listTasks', 'tasks', RequestMethod.GET],
    [BusinessSemanticsWorkbenchController, 'trace', 'tasks/:id/trace', RequestMethod.GET],
  ] as const)('binds %p.%s to %s', (controller, handler, expectedPath, expectedMethod) => {
    expect(route(controller, handler)).toEqual({
      path: expectedPath,
      method: expectedMethod,
    });
  });
});
