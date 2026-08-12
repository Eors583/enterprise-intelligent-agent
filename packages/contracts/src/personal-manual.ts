import { z } from 'zod';

const UUID = z.uuid();
const nullableProfileTextSchema = z.string().trim().max(5_000).nullable();

export const personalManualFaqSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    answer: z.string().trim().min(1).max(5_000),
  })
  .strict();

export const personalManualContentSchema = z
  .object({
    personalSummary: nullableProfileTextSchema,
    educationBackground: nullableProfileTextSchema,
    careerOverview: nullableProfileTextSchema,
    jobResponsibilities: nullableProfileTextSchema,
    communicationPreference: nullableProfileTextSchema,
    collaborationHabits: nullableProfileTextSchema,
    routineSchedule: nullableProfileTextSchema,
    contactInformation: nullableProfileTextSchema,
    coreSkills: nullableProfileTextSchema,
    availableResources: nullableProfileTextSchema,
    hobbies: nullableProfileTextSchema,
    clubs: nullableProfileTextSchema,
    faqs: z.array(personalManualFaqSchema).max(20),
  })
  .strict();

export const personalManualSelfProfileSchema = z
  .object({
    user: z.object({
      id: UUID,
      displayName: z.string().min(1).max(120),
      email: z.email(),
      phone: z.string().nullable(),
      avatarUrl: z.url().nullable(),
    }),
    employment: z
      .object({
        departmentName: z.string().min(1),
        title: z.string().nullable(),
        employeeNumber: z.string().nullable(),
        employmentType: z
          .enum(['REGULAR', 'INTERN', 'OUTSOURCED', 'LABOR', 'CONSULTANT'])
          .nullable(),
      })
      .nullable(),
    manual: personalManualContentSchema,
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const updatePersonalManualRequestSchema = z
  .object({
    expectedUpdatedAt: z.iso.datetime().nullable(),
    manual: personalManualContentSchema,
  })
  .strict();

export type PersonalManualFaq = z.infer<typeof personalManualFaqSchema>;
export type PersonalManualContent = z.infer<typeof personalManualContentSchema>;
export type PersonalManualSelfProfile = z.infer<typeof personalManualSelfProfileSchema>;
export type UpdatePersonalManualRequest = z.infer<typeof updatePersonalManualRequestSchema>;
