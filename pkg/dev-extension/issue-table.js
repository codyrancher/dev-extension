/**
 * The assigned-issues table, shared by the two pages that draw it.
 *
 * My Work's Issues tab and the Issue tracker show the same rows with the same columns, because
 * they are the same question asked at two depths: My Work is the glance, the tracker is where
 * an issue is followed through its stages. "The same columns as my-work" is the requirement, so
 * the columns live here rather than being copied - a copy is the same table until the first
 * time only one of them gains a column.
 *
 * Only the data and the column definitions. The cells are a page's own business: the tracker
 * draws an expander where My Work draws nothing, and a shared template would need a flag per
 * difference.
 */

import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACE_ROUTE, CREATE_ROUTE, DEFAULT_APP, LTE_APP, lteName, isLte
} from './config/constants';

/**
 * The phone's version of a header list: the few columns worth the width, and no fixed widths.
 * Exported because My Work's other three tables narrow the same way.
 */
export function narrowed(all, keep) {
  return all
    .filter((column) => keep.includes(column.name))
    .map(({ width, ...column }) => column); // eslint-disable-line no-unused-vars
}

const STATUS_ORDER = [
  'working', 'in progress',
  'next up', 'todo', 'to do',
  'to triage', 'triage', 'new',
  'review', 'in review',
  'qa working', 'qa review', 'to test',
  'backlog', 'ice box',
];
const STATUS_TERMINAL = ['done', 'closed'];

function statusRank(status) {
  if (!status) {
    return STATUS_ORDER.length + 2;
  }

  const name = status.name.toLowerCase();

  if (STATUS_TERMINAL.includes(name)) {
    return STATUS_ORDER.length + 1;
  }

  const i = STATUS_ORDER.indexOf(name);

  return i === -1 ? STATUS_ORDER.length : i;
}

// The board's own colour for a column, in this dashboard's palette. A board anyone can add a
// column to would otherwise leave every unfamiliar status looking identical.

const STATUS_HUE = {
  GRAY:   'muted',
  BLUE:   'info',
  GREEN:  'success',
  YELLOW: 'warning',
  ORANGE: 'warning',
  RED:    'error',
  PINK:   'accent',
  PURPLE: 'accent',
};

export const ISSUE_COLUMNS = [
  {
    name: 'number', label: 'Issue', value: 'number', width: 90
  },
  { name: 'title', label: 'Title', value: 'title' },
  // The board's Status column, sorted by how much of your attention a status wants rather
  // than alphabetically - the rank is a field on the row, see issueRows.
  {
    name: 'status', label: 'Status', value: 'statusRank', sort: ['statusRank', 'createdAt:desc'], width: 130
  },
  /*
   * The milestone, sorted with the issues that have none at the end rather than the front.
   *
   * Most of these have no milestone, and an ascending sort that opens with forty blanks is not
   * the sort anybody pressed for. The rank is a field on the row for the same reason the board
   * status is one - SortableTable sorts the value it is given - see issueRows.
   */
  {
    name: 'milestone', label: 'Milestone', value: 'milestone', sort: ['milestoneSort', 'createdAt:desc'], width: 150
  },
  {
    name: 'age', label: 'Age', value: 'createdAt', sort: ['createdAt'], width: 90
  },
  /*
   * When it became yours, which is not when it was raised: the oldest issue here was assigned
   * four months ago and opened four years ago, and only one of those is a fact about you.
   *
   * Newest first, because the question this column answers is "what have I just been handed".
   */
  {
    name: 'assigned', label: 'Assigned', value: 'assignedAt', sort: ['assignedAt:desc'], width: 110
  },
  {
    name: 'workspace', label: 'Workspace', value: 'key', width: 130
  },
  {
    name: 'actions', label: 'Actions', align: 'right', width: 110
  },
];

export const NARROW_ISSUE_COLUMNS = ['number', 'title', 'actions'];

/** The columns this width can carry. */
export function issueHeadersFor(narrow) {
  return narrow ? narrowed(ISSUE_COLUMNS, NARROW_ISSUE_COLUMNS) : ISSUE_COLUMNS;
}

/**
 * The issues with the two sort keys the table needs on them.
 *
 * `statusRank` orders by how much of a person's attention a board status wants rather than
 * alphabetically; `milestoneSort` puts the issues in no milestone after the ones in one. Both
 * are fields rather than comparators because SortableTable sorts the value it is given.
 */
export function issueRowsFrom(issues) {
  return (issues || []).map((issue) => ({
    ...issue,
    statusRank:    String(statusRank(issue.projectStatus)).padStart(2, '0'),
    milestoneSort: issue.milestone || '\uffff',
  }));
}

/** The hue a board status is drawn in. */
export function statusHue(status) {
  return STATUS_HUE[(status?.color || '').toUpperCase()] || 'muted';
}

/**
 * The milestone's due date, for the column's tooltip.
 *
 * A title alone does not say whether the date it is named for has passed, and `25.01` means
 * nothing to anybody who does not already know the release calendar.
 */
export function milestoneDue(row) {
  if (!row.milestoneDue) {
    return row.milestone ? `${ row.milestone } - no due date` : '';
  }
  const due = new Date(row.milestoneDue);

  return `${ row.milestone } - due ${ due.toLocaleDateString() }${ due.getTime() < Date.now() ? ' (overdue)' : '' }`;
}

/*
 * Where an issue's workspace is, and what it is called.
 *
 * Shared for the same reason the columns are: the Workspace column means the same thing on both
 * pages, and "the same column" that resolves a different name on each is worse than two columns.
 * Pure, taking the workspace names rather than reading them, so neither page has to be a class
 * for the other to borrow from.
 */

/**
 * The name new work goes under: a leased workspace (`lte-issue-18536`), unless a workspace of
 * the plain name already exists, in which case the work keeps exactly the one it has.
 */
export function workspaceNameFor(workspaces, base) {
  return (workspaces || []).includes(base) ? base : lteName(base);
}

/** The App a workspace of that name is made from. */
export function appForWorkspace(name) {
  return isLte(name) ? LTE_APP : DEFAULT_APP;
}

export function issueWorkspaceName(workspaces, issue) {
  return workspaceNameFor(workspaces, `issue-${ issue.number }`);
}

export function hasIssueWorkspace(workspaces, issue) {
  return (workspaces || []).includes(issueWorkspaceName(workspaces, issue));
}

/** The workspace if it exists, otherwise the create form filled in for it. */
export function issueWorkspaceLocation(workspaces, issue) {
  const name = issueWorkspaceName(workspaces, issue);

  if ((workspaces || []).includes(name)) {
    return {
      name:   WORKSPACE_ROUTE,
      params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: name },
    };
  }

  return {
    name:   CREATE_ROUTE,
    params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER },
    query:  { app: appForWorkspace(name), name },
  };
}
