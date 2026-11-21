/**
 * DynamoDB implementation of IssueRepository, used in production on AWS.
 *
 * It passes the same contract test suite as the SQLite implementation
 * (tests/db/repositoryContract.ts), run against DynamoDB Local.
 *
 * How the SQL features map to DynamoDB (see table.ts for the key design):
 *  - WHERE status = ?        → Query on gsi2 (key condition, no wasted reads)
 *  - ORDER BY created DESC   → GSI sort key `<createdAt>#<id>`, ScanIndexForward=false
 *  - other filters / LIKE    → FilterExpression, applied AFTER items are read
 *  - LIMIT n                 → keep paging until n items matched (DynamoDB's own
 *                              `Limit` counts items read BEFORE filtering)
 *  - ON DELETE CASCADE       → query the issue's partition, batch-delete everything
 *  - case-insensitive match  → lower-cased copies of assignee / title / description
 *                              (`contains()` in DynamoDB is case-sensitive)
 *  - transaction             → TransactWriteItems (add comment + bump updatedAt)
 *
 * Consistency: getIssue uses strongly consistent reads; GSI queries (list,
 * search, summary) are eventually consistent, so a just-created issue can take
 * a moment to appear in list results on real AWS.
 */
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { NotFoundError } from '../../lib/errors.js';
import { newCommentId, newIssueId } from '../../lib/ids.js';
import {
  clampLimit,
  emptySummary,
  normalizeLabels,
  type AddCommentInput,
  type Comment,
  type CreateIssueInput,
  type Issue,
  type IssueFilter,
  type IssuePriority,
  type IssueStatus,
  type IssueSummary,
  type UpdateIssueInput,
} from '../../models/issue.js';
import type { IssueRepository } from '../IssueRepository.js';
import {
  ALL_ISSUES_PK,
  COMMENT_SK_PREFIX,
  KEYS,
  META_SK,
  commentSk,
  createdSk,
  issuePk,
  statusPk,
} from './table.js';

type Item = Record<string, unknown>;

export interface DynamoRepositoryOptions {
  tableName: string;
  /** DynamoDB Local URL, e.g. http://localhost:8000. Leave unset on AWS. */
  endpoint?: string | undefined;
  region?: string | undefined;
  /** Injectable clock (tests). */
  now?: () => Date;
  /**
   * Max items DynamoDB reads per page. Unset = DynamoDB's default (up to 1 MB).
   * Tests set it very low to exercise the pagination logic.
   */
  pageSize?: number | undefined;
}

/** BatchWriteItem accepts at most 25 requests per call. */
const BATCH_SIZE = 25;
const MAX_BATCH_RETRIES = 5;

function itemToIssue(item: Item): Issue {
  return {
    id: item.id as string,
    title: item.title as string,
    description: item.description as string,
    status: item.status as IssueStatus,
    priority: item.priority as IssuePriority,
    assignee: (item.assignee as string | null | undefined) ?? null,
    labels: (item.labels as string[] | undefined) ?? [],
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

function itemToComment(item: Item): Comment {
  return {
    id: item.id as string,
    issueId: item.issueId as string,
    author: item.author as string,
    text: item.text as string,
    createdAt: item.createdAt as string,
  };
}

/** The full item stored for an issue: the domain fields plus keys and helper attributes. */
function issueToItem(issue: Issue): Item {
  return {
    [KEYS.pk]: issuePk(issue.id),
    [KEYS.sk]: META_SK,
    [KEYS.gsi1.pk]: ALL_ISSUES_PK,
    [KEYS.gsi1.sk]: createdSk(issue.createdAt, issue.id),
    [KEYS.gsi2.pk]: statusPk(issue.status),
    [KEYS.gsi2.sk]: createdSk(issue.createdAt, issue.id),
    type: 'issue',
    ...issue,
    // Lower-cased copies for case-insensitive filtering and search.
    titleLower: issue.title.toLowerCase(),
    descriptionLower: issue.description.toLowerCase(),
    ...(issue.assignee !== null && { assigneeLower: issue.assignee.toLowerCase() }),
  };
}

export class DynamoIssueRepository implements IssueRepository {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly now: () => Date;
  private readonly pageSize: number | undefined;

  constructor(
    private readonly client: DynamoDBClient,
    options: {
      tableName: string;
      now?: (() => Date) | undefined;
      pageSize?: number | undefined;
    },
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
    this.tableName = options.tableName;
    this.now = options.now ?? (() => new Date());
    this.pageSize = options.pageSize;
  }

  static create(options: DynamoRepositoryOptions): DynamoIssueRepository {
    const client = new DynamoDBClient({
      ...(options.region && { region: options.region }),
      ...(options.endpoint && {
        endpoint: options.endpoint,
        // DynamoDB Local ignores credentials, but the SDK insists on having some.
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
        region: options.region ?? 'us-east-1',
      }),
    });
    return new DynamoIssueRepository(client, {
      tableName: options.tableName,
      now: options.now,
      pageSize: options.pageSize,
    });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  /**
   * Run a Query, following pagination until `limit` items have been collected
   * (or the index is exhausted). Needed because DynamoDB applies FilterExpression
   * AFTER reading a page, so one page can contain few or zero matches.
   */
  private async queryAll(input: Omit<QueryCommandInput, 'TableName'>, limit = Infinity) {
    const items: Item[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.doc.send(
        new QueryCommand({
          ...input,
          TableName: this.tableName,
          ExclusiveStartKey: startKey,
          ...(this.pageSize !== undefined && { Limit: this.pageSize }),
        }),
      );
      items.push(...((page.Items ?? []) as Item[]));
      startKey = page.LastEvaluatedKey;
    } while (startKey && items.length < limit);
    return items.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Issues
  // -------------------------------------------------------------------------

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const ts = this.timestamp();
    const issue: Issue = {
      id: newIssueId(),
      title: input.title,
      description: input.description,
      status: 'open',
      priority: input.priority,
      assignee: input.assignee ?? null,
      labels: normalizeLabels(input.labels),
      createdAt: ts,
      updatedAt: ts,
    };
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: issueToItem(issue),
        ConditionExpression: 'attribute_not_exists(pk)', // never overwrite on an id collision
      }),
    );
    return issue;
  }

  async getIssue(id: string): Promise<Issue | null> {
    const { Item: item } = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [KEYS.pk]: issuePk(id), [KEYS.sk]: META_SK },
        ConsistentRead: true, // read-your-own-writes for single-issue lookups
      }),
    );
    return item ? itemToIssue(item) : null;
  }

  async listIssues(filter: IssueFilter = {}): Promise<Issue[]> {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const filters: string[] = [];

    // 1. Pick the index: by-status if filtering on status, otherwise all issues.
    const index = filter.status ? KEYS.gsi2 : KEYS.gsi1;
    names['#pk'] = index.pk;
    values[':pk'] = filter.status ? statusPk(filter.status) : ALL_ISSUES_PK;
    let keyCondition = '#pk = :pk';
    if (filter.createdAfter) {
      // "<createdAt>#<id>" >= "<createdAfter>" ⇔ createdAt >= createdAfter
      names['#sk'] = index.sk;
      values[':createdAfter'] = filter.createdAfter;
      keyCondition += ' AND #sk >= :createdAfter';
    }

    // 2. Everything else becomes a FilterExpression.
    if (filter.priority) {
      names['#priority'] = 'priority';
      values[':priority'] = filter.priority;
      filters.push('#priority = :priority');
    }
    if (filter.assignee) {
      values[':assignee'] = filter.assignee.trim().toLowerCase();
      filters.push('assigneeLower = :assignee');
    }
    if (filter.label) {
      values[':label'] = filter.label.trim().toLowerCase();
      filters.push('contains(labels, :label)');
    }
    if (filter.updatedAfter) {
      values[':updatedAfter'] = filter.updatedAfter;
      filters.push('updatedAt >= :updatedAfter');
    }

    const items = await this.queryAll(
      {
        IndexName: index.name,
        KeyConditionExpression: keyCondition,
        ...(filters.length > 0 && { FilterExpression: filters.join(' AND ') }),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ScanIndexForward: false, // newest first
      },
      clampLimit(filter.limit),
    );
    return items.map(itemToIssue);
  }

  async updateIssue(id: string, changes: UpdateIssueInput): Promise<Issue> {
    const hasChanges = Object.values(changes).some((v) => v !== undefined);
    if (!hasChanges) {
      // Nothing to change: return as-is rather than bumping updatedAt.
      const current = await this.getIssue(id);
      if (!current) throw new NotFoundError('Issue', id);
      return current;
    }

    const set: string[] = ['updatedAt = :updatedAt'];
    const remove: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = { ':updatedAt': this.timestamp() };

    if (changes.title !== undefined) {
      set.push('title = :title', 'titleLower = :titleLower');
      values[':title'] = changes.title;
      values[':titleLower'] = changes.title.toLowerCase();
    }
    if (changes.description !== undefined) {
      set.push('description = :description', 'descriptionLower = :descriptionLower');
      values[':description'] = changes.description;
      values[':descriptionLower'] = changes.description.toLowerCase();
    }
    if (changes.status !== undefined) {
      // Status is part of the gsi2 key, so moving status moves the item in the index.
      names['#status'] = 'status';
      names['#gsi2pk'] = KEYS.gsi2.pk;
      set.push('#status = :status', '#gsi2pk = :gsi2pk');
      values[':status'] = changes.status;
      values[':gsi2pk'] = statusPk(changes.status);
    }
    if (changes.priority !== undefined) {
      names['#priority'] = 'priority';
      set.push('#priority = :priority');
      values[':priority'] = changes.priority;
    }
    if (changes.assignee !== undefined) {
      set.push('assignee = :assignee');
      values[':assignee'] = changes.assignee;
      if (changes.assignee === null) {
        remove.push('assigneeLower');
      } else {
        set.push('assigneeLower = :assigneeLower');
        values[':assigneeLower'] = changes.assignee.toLowerCase();
      }
    }
    if (changes.labels !== undefined) {
      set.push('labels = :labels');
      values[':labels'] = normalizeLabels(changes.labels);
    }

    try {
      const { Attributes } = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [KEYS.pk]: issuePk(id), [KEYS.sk]: META_SK },
          UpdateExpression:
            `SET ${set.join(', ')}` + (remove.length > 0 ? ` REMOVE ${remove.join(', ')}` : ''),
          // Without this, UpdateItem would happily CREATE a half-empty item.
          ConditionExpression: 'attribute_exists(pk)',
          ...(Object.keys(names).length > 0 && { ExpressionAttributeNames: names }),
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return itemToIssue(Attributes as Item);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw new NotFoundError('Issue', id);
      throw err;
    }
  }

  async deleteIssue(id: string): Promise<void> {
    // Everything for this issue lives in one partition: META + comments.
    const items = await this.queryAll({
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': issuePk(id) },
      ProjectionExpression: 'pk, sk',
    });
    if (!items.some((item) => item.sk === META_SK)) throw new NotFoundError('Issue', id);

    // Delete comments first and the issue last: if we fail half-way, the issue
    // still exists and a retry finishes the job (no orphaned comments).
    const keys = items.map((item) => ({ pk: item.pk, sk: item.sk }));
    const ordered = [
      ...keys.filter((k) => k.sk !== META_SK),
      ...keys.filter((k) => k.sk === META_SK),
    ];
    for (let i = 0; i < ordered.length; i += BATCH_SIZE) {
      await this.batchDelete(ordered.slice(i, i + BATCH_SIZE));
    }
  }

  /** BatchWriteItem may return UnprocessedItems under load: retry with backoff. */
  private async batchDelete(keys: Item[]): Promise<void> {
    let requests = keys.map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt > MAX_BATCH_RETRIES) throw new Error('BatchWrite: unprocessed items remain');
      if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      const { UnprocessedItems } = await this.doc.send(
        new BatchWriteCommand({ RequestItems: { [this.tableName]: requests } }),
      );
      requests = (UnprocessedItems?.[this.tableName] ?? []) as typeof requests;
    }
  }

  async searchIssues(keyword: string, limit?: number): Promise<Issue[]> {
    const term = keyword.trim().toLowerCase();
    if (term.length === 0) return [];
    // No full-text index in DynamoDB: walk all issues newest first and filter.
    // Fine for thousands of issues; OpenSearch would be the next step.
    const items = await this.queryAll(
      {
        IndexName: KEYS.gsi1.name,
        KeyConditionExpression: '#pk = :pk',
        FilterExpression: 'contains(titleLower, :term) OR contains(descriptionLower, :term)',
        ExpressionAttributeNames: { '#pk': KEYS.gsi1.pk },
        ExpressionAttributeValues: { ':pk': ALL_ISSUES_PK, ':term': term },
        ScanIndexForward: false,
      },
      clampLimit(limit),
    );
    return items.map(itemToIssue);
  }

  async getSummary(): Promise<IssueSummary> {
    // Reads only two small attributes per issue. With very large tables you'd
    // maintain counters instead (e.g. via DynamoDB Streams).
    const items = await this.queryAll({
      IndexName: KEYS.gsi1.name,
      KeyConditionExpression: '#pk = :pk',
      ProjectionExpression: '#status, #priority',
      ExpressionAttributeNames: {
        '#pk': KEYS.gsi1.pk,
        '#status': 'status',
        '#priority': 'priority',
      },
      ExpressionAttributeValues: { ':pk': ALL_ISSUES_PK },
    });
    const summary = emptySummary();
    for (const item of items) {
      summary.total += 1;
      summary.byStatus[item.status as IssueStatus] += 1;
      summary.byPriority[item.priority as IssuePriority] += 1;
    }
    return summary;
  }

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  async addComment(input: AddCommentInput): Promise<Comment> {
    const ts = this.timestamp();
    const comment: Comment = {
      id: newCommentId(),
      issueId: input.issueId,
      author: input.author,
      text: input.text,
      createdAt: ts,
    };

    try {
      // Atomic: bump the issue's updatedAt (and prove it exists) + insert the comment.
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { [KEYS.pk]: issuePk(input.issueId), [KEYS.sk]: META_SK },
                UpdateExpression: 'SET updatedAt = :ts',
                ConditionExpression: 'attribute_exists(pk)',
                ExpressionAttributeValues: { ':ts': ts },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  [KEYS.pk]: issuePk(input.issueId),
                  [KEYS.sk]: commentSk(ts, comment.id),
                  type: 'comment',
                  ...comment,
                },
              },
            },
          ],
        }),
      );
    } catch (err) {
      const issueMissing =
        err instanceof TransactionCanceledException &&
        err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
      if (issueMissing) throw new NotFoundError('Issue', input.issueId);
      throw err;
    }
    return comment;
  }

  async listComments(issueId: string): Promise<Comment[]> {
    const items = await this.queryAll({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': issuePk(issueId), ':prefix': COMMENT_SK_PREFIX },
      ScanIndexForward: true, // oldest first
    });
    return items.map(itemToComment);
  }

  async close(): Promise<void> {
    this.client.destroy(); // idempotent: closes the HTTP connection pool
  }
}
