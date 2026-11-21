## API

All functions take a string and are exported from their file in `src/`.

### `slugify(text)`

Turns a title into a URL slug: lower case, accents removed, every run of other
characters replaced by one dash, no dash at either end.

```js
slugify('Crème Brûlée & Co.'); // 'creme-brulee-co'
```

### `wordcount(text)`

Returns the number of whitespace-separated words; blank text gives `0`.

```js
wordcount('  one two\nthree '); // 3
```

### `summarize(text)`

Returns `{ slug, words }` built with the two functions above.

```js
summarize('Hello, World!'); // { slug: 'hello-world', words: 2 }
```
