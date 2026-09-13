# @graphile-contrib/view-constraints

An opt-in PostGraphile v5 plugin that derives a view's foreign keys, primary
key, and non-null columns from PostgreSQL's query plan and system catalogs.

## Install

```sh
npm install @graphile-contrib/view-constraints
```

## Use

```ts
import { PgViewConstraintsPlugin } from "@graphile-contrib/view-constraints";

export default {
  plugins: [PgViewConstraintsPlugin({ declare: true })],
};
```

The plugin runs before `PgFakeConstraintsPlugin`, which turns the derived tags
into relations in the generated schema.
