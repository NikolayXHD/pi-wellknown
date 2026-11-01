# pi-wellknown

Pi provider discovery through the `/.well-known/opencode` manifest that coding
agents use. A service that publishes the manifest gets its models into
`/model`, `/login`-free, from its own catalog.

## Install

```bash
pi install git:github.com/NikolayXHD/pi-wellknown
```

## Usage

Declare a provider in `~/.pi/agent/wellknown.json`. The top-level key is the
Pi provider id, the URL is the service that answers
`/.well-known/opencode`:

```json
{
  "acme": {
    "wellKnownUrl": "https://api.acme.example",
    "defaultTransport": { "api": "openai-completions" }
  }
}
```

Save the API key under the provider id in `~/.pi/agent/auth.json`:

```json
{
  "acme": {
    "type": "api_key",
    "key": "sk-..."
  }
}
```

Or put it in the environment variable the manifest names. Start Pi: the models
are in `/model` and in `pi --list-models`, each one selectable by its id.

```bash
pi --model acme/chat-large
```

`wellknown.example.json` shows a full config: transports per vendor, a price
list, a cost multiplier.

To try a package without installing it:

```bash
pi -e ./pi-wellknown
```

## How it works

For every provider in the config the extension does three things.

It fetches `<wellKnownUrl>/.well-known/opencode`. The manifest names a command
that prints the API key on standard output and a URL that serves the remote
config, optionally with request headers.

It runs the command and calls the config URL with those headers, substituting
`{env:NAME}` from the manifest's key. The config lists models with context and
output limits, tool-calling and reasoning flags, input modalities, pricing, and
the endpoint they answer on.

It registers the provider in Pi: every model an agent can drive, with the
transport chosen per vendor. Vendor means the first segment of a model id, so
`acme/chat-large` goes through the transport configured for `acme`.

## Configuration

The config is `wellknown.json` in the agent directory, overridable with
`PI_WELLKNOWN_CONFIG`. Every top-level key is a Pi provider id. See
`wellknown.example.json`.

`wellKnownUrl` is the base URL that answers `/.well-known/opencode`.

`keyCommand` overrides the key command from the manifest, for keys that live
somewhere other than the environment variable the manifest expects.

The key the manifest's command expects is taken from the credential Pi stores
for the provider, when one exists, and passed in that variable. Without a
stored credential the command runs with the inherited environment, so a service
that reads its key from the shell keeps working.

`transports` maps a vendor to a protocol: `api` plus an optional `baseUrl`
when that protocol lives on a different path than the remote config endpoint.

`defaultTransport` is the protocol for vendors without an entry in
`transports`, usually plain `openai-completions`.

`costMultiplier` multiplies every published price. Use it to rebase a currency,
or to keep a billed amount in the range Pi prints.

`cacheReadsIncludedInInput` says the provider counts cache reads inside its
input token count. Pi bills input and cache reads separately, so the extension
subtracts them and recomputes the cost. Turn it on only when the provider
really does count them inside input.

`pricing` is an optional price list. The entry shape is described by dot paths
and field names, so a list that does not carry prices inside the model catalog
still reaches Pi's cost accounting.

Prices are display values. Pi prints cost with a dollar sign and offers no
currency setting, so a provider that bills in another currency should keep
`costMultiplier` such that the printed order of magnitude stays recognizable.
Model ratios remain exact.

## Limits

The extension trusts the manifest. The key command runs on your machine, and
the remote config decides which models appear.

A provider that publishes no context or output limit for a model is skipped for
that model: Pi needs both to plan a session.

Pi fetches provider catalogs from the network only in the interactive UI, so
the extension reads the catalog in its factory, before startup. An unreachable
provider fails the extension with its provider id in the message.
