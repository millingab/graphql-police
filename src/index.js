// @flow

import 'babel-polyfill';
import './config';
import app from './app';

const port = process.env.PORT || 7010;

(async () => {
  await app.listen(port);
  console.log(`GraphQLPolice started on port ${port}`);
})();
