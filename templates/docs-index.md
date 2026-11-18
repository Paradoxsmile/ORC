# {{PROJECT_NAME}} — knowledge base

Map of content. Keep this short; link, don't duplicate.

- [Architecture](architecture.md)
- [Decisions](decisions/)
- [Specs](specs/)

## Open work

```dataview
TABLE status, agent, branch
FROM "docs/specs"
WHERE status != "done"
SORT created DESC
```
