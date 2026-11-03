/** A failed GitHub API call, with a next action for the agent. */
export class GitHubError extends Error {
    status;
    nextAction;
    request;
    details;
    constructor(status, message, nextAction, 
    /** Method and path of the failed request, e.g. `PATCH /repos/o/r/git/refs/heads/main`. */
    request, 
    /** GitHub's own error details (`errors[]`), if any. */
    details = []) {
        super(message);
        this.status = status;
        this.nextAction = nextAction;
        this.request = request;
        this.details = details;
        this.name = "GitHubError";
    }
}
export function parseRateLimit(headers) {
    const limit = headers.get("x-ratelimit-limit");
    const remaining = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset");
    if (limit === null || remaining === null || reset === null)
        return undefined;
    return {
        limit: Number(limit),
        remaining: Number(remaining),
        used: Number(headers.get("x-ratelimit-used") ?? Number(limit) - Number(remaining)),
        reset: new Date(Number(reset) * 1000),
        resource: headers.get("x-ratelimit-resource") ?? "core",
    };
}
/** The next action for a failed request, by status. */
export function nextActionFor(status, message, rate, retryAfter) {
    const lower = message.toLowerCase();
    if (status === 401) {
        return "The token in IDC365_DECISIONS_TOKEN is invalid or expired. Create a new one as described in the README section \"Documentation token\" and set it again.";
    }
    if (status === 429 || (status === 403 && (rate?.remaining === 0 || lower.includes("rate limit")))) {
        const when = retryAfter ? `in ${retryAfter} seconds` : rate ? `at ${rate.reset.toISOString()}` : "later";
        return `GitHub's rate limit is used up. Wait and run the command again ${when}.`;
    }
    if (lower.includes("rule violation") || lower.includes("protected branch")) {
        return "The repository's rules block this change. Truth branches change only through a pull request that a human merges.";
    }
    if (status === 403) {
        return "The token lacks permission for this. It needs Contents and Pull requests read and write on the documentation repository (README section \"Documentation token\").";
    }
    if (status === 404) {
        return "Not found, or the token cannot see it. Check the repository in .idc365-decisions.json and that the token has access to it.";
    }
    if (status === 409)
        return "The data changed on GitHub at the same time. Run the command again.";
    if (status === 422)
        return "GitHub rejected the request as invalid. Check the details and correct the input.";
    if (status >= 500)
        return "GitHub had an internal error. Run the command again in a minute.";
    return "Check the details and run the command again.";
}
