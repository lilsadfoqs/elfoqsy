// Jira Cloud as a tracker: the open sprints of the configured projects, through REST v3 with an API token.
import type { Ticket } from '@elfoqsy/contracts';
import { sprintJql, type JiraClient } from '../jira/client';
import { jiraFields, mapIssue, type MapOptions } from '../jira/map';
import type { TrackerAdapter } from './types';

export class JiraTracker implements TrackerAdapter {
  readonly id = 'jira';
  constructor(
    private readonly client: Pick<JiraClient, 'search'>,
    readonly projects: readonly string[],
    private readonly fields: MapOptions,
  ) {}

  async currentTickets(): Promise<Ticket[]> {
    const issues = await this.client.search(sprintJql([...this.projects]), jiraFields(this.fields));
    return issues.map((issue) => mapIssue(issue, this.fields));
  }
}
