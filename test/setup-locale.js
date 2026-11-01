// Most tests read the engine's Turkish messages: unless a test says otherwise, Windows is Turkish for the whole run.
process.env.HYPERNAB_LOCALE ??= 'tr-TR';
