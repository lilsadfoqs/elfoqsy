// Loads and validates mock/sprint-52.json: the sprint the simulator starts from. Agents come from sim/scenario.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { prioritySchema, ticketStatusSchema, ticketTypeSchema } from '@elfoqsy/contracts';

const sprintFileSchema = z.object({
  jira: z.object({
    site: z.string(),
    sprints: z.array(z.object({ board: z.string(), name: z.string(), state: z.string() })),
  }),
  openTickets: z.array(
    z.object({
      key: z.string(),
      board: z.string(),
      summary: z.string(),
      type: ticketTypeSchema,
      status: ticketStatusSchema,
      priority: prioritySchema,
      storyPoints: z.number().nullable(),
      sprintsCarried: z.number().int(),
      epic: z.string().nullable(),
      sprint: z.string(),
      reporter: z.string(),
      created: z.string(),
      updated: z.string(),
      labels: z.array(z.string()),
      linked: z.array(z.string()),
      descriptionSummary: z.string(),
    }),
  ),
  closedTickets: z.array(
    z.object({
      key: z.string(),
      summary: z.string(),
      type: ticketTypeSchema,
      status: ticketStatusSchema,
      priority: prioritySchema,
      storyPoints: z.number().nullable(),
    }),
  ),
  pullRequests: z.array(
    z.object({
      repo: z.string(),
      number: z.number().int(),
      state: z.enum(['open', 'draft', 'merged', 'closed']),
      ticket: z.string(),
    }),
  ),
});

export type SprintFile = z.infer<typeof sprintFileSchema>;

export interface Mock {
  sprint: SprintFile;
}

export function loadMock(dir: string): Mock {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  return {
    sprint: sprintFileSchema.parse(read('sprint-52.json')),
  };
}
