# Knowledge and external connections

Connections belong to the selected server environment. The browser's filesystem, environment variables, or credentials cannot stand in for those of a remote host.

Obsidian reads and writes stay inside the configured vault, reject symlink escapes, and use content versions to avoid overwriting a changed note. Automatic recall must use the same access boundary. A search match is source material, not an instruction or permission.

Reviewed mission capture and automatic recall have different purposes: capture persists a human-reviewed lesson; recall selects existing evidence for a new task. Recall must not write notes or export a raw transcript as a side effect. See [the memory bridge](../../../../docs/operations/synthos-memory.md).

Availability, authentication, and observed activity are separate facts. An executable on PATH or a configured key does not prove that a service is connected or running. Remote MCP activity is unknown unless measured through its actual provider connection.

DAM is the asset library's system of record. SynthOS reads it only through DAM's own read-only MCP server, spawned from the configured checkout without a shell or SynthOS credentials, and keeps no copy. Owner-only items need both the host opt-in and the actor's `filesystem:read`; every other request reaches only the public process. DAM output, including file contents and quoted upstream text, is untrusted data: decoded within bounds, never interpreted.

Mail delivery uses an immutable reviewed envelope. An unknown send result requires reconciliation before retry; a failed observation does not establish failed delivery. See [knowledge and mail](../../../../docs/user/synthos.md#connect-knowledge-and-mail).
