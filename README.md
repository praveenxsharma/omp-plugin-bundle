# omp-antigravity-acp

OMP plugin that uses the official Google Antigravity CLI (`agy acp`) as a first-class model provider.

OMP already has a built-in `google-antigravity` provider that talks HTTP to Cloud Code Assist. Google gates those models to their own client. This plugin does **not** send requests from OMP to that API. It starts the signed-in official `agy` process and speaks [Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction) over stdio. Login stays in the official process and OS credential store.

| Directory | What it is |
|---|---|
| [`omp-antigravity-acp`](./omp-antigravity-acp) | OMP extension. Registers provider `antigravity` (`antigravity/gemini-4-argon`, Claude, …). |
| [`agy-context-unlock`](./agy-context-unlock) | Optional local patch. Raises the official client's default 256K context to about 1M. Rewrites the `agy` binary. Not installed with the plugin. |

Install the plugin:

```sh
omp plugin link ./omp-antigravity-acp
```

Or from this GitHub repo:

```sh
omp plugin install github:praveenxsharma/omp-plugin-bundle
```

ACP docs: [Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction). `agy acp` product docs: [Antigravity CLI ACP](https://antigravity.google/docs/cli/acp/).

## Community

This project is discussed on [LINUX DO](https://linux.do).
