import { BadRequestException, type PipeTransform } from '@nestjs/common';

interface SchemaSuccess<T> {
  readonly success: true;
  readonly data: T;
}

interface SchemaFailure {
  readonly success: false;
  readonly error: {
    readonly issues: readonly {
      readonly path: readonly PropertyKey[];
      readonly message: string;
    }[];
  };
}

export interface RuntimeSchema<T> {
  safeParse(value: unknown): SchemaSuccess<T> | SchemaFailure;
}

export class SchemaValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: RuntimeSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new BadRequestException(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
}
