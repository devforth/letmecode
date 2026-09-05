
# Important

Always try to run `pnpm start` after any changes to test them

# Compatibility policy

Do not add or preserve backward compatibility for old Codex or Claude versions, legacy event schemas, or incomplete historical usage events. LetMeCode should support only the current event contracts.

Silently ignore events that do not satisfy the current contract. Do not infer missing fields, guess defaults, emit compatibility warnings, or retain fallback parsing paths and tests solely for legacy data.

# Skills

The project-local source of truth for the skills is `skills/`.
