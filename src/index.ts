import fastGlob from 'fast-glob';
import { Plugin } from 'esbuild';
import fs from 'fs';
import path from 'node:path';
import Ajv from 'ajv/dist/2019';
import addFormats from 'ajv-formats';
import { default as standaloneCode } from 'ajv/dist/standalone';
const EsbuildPluginImportGlob = (options): Plugin => ({
  name: 'require-context',
  setup: (build) => {
    build.onResolve({ filter: /\*/ }, async (args) => {
      if (args.resolveDir === '') {
        return; // Ignore unresolvable paths
      }

      return {
        path: args.path,
        namespace: 'import-glob',
        pluginData: {
          resolveDir: args.resolveDir,
        },
      };
    });

    build.onLoad({ filter: /.*/, namespace: 'import-glob' }, async (args) => {
      const files = (
        await fastGlob(args.path, {
          cwd: args.pluginData.resolveDir,
        })
      ).sort();
   
      const nonShemaFiles = files.filter((file) => !file.endsWith('schema.json'));
      const schemaFiles = files.filter((file) => file.endsWith('schema.json'));
      const compileSchema = (filePath) => {
        const file = fs.readFileSync(filePath, 'utf-8');
        const defaultAjvOptions = { ...options };
        // Maybe will be used in future
        // { sourceCode: true } should not be overridden
        if (options.serverSide && options.ajv && options.ajv.allErrors) {
          options.ajv.allErrors = false;
        }

        if (options.serverSide) {
          defaultAjvOptions.allErrors = false;
        }

        const ajvOptions = Object.assign(
          {},
          defaultAjvOptions,
          options.ajv || {},
          {
            code: { source: true },
          }
        );

        let ajv = new Ajv(ajvOptions);
        if (!options.serverSide) {
          require('ajv-errors')(ajv /*, {singleError: true} */);
        }
        addFormats(ajv);
        let schema;

        try {
          schema = JSON.parse(file);
        } catch (e) {
          console.log('Schema is not a valid JSON: ' + filePath);
          return;
        }
        const validate = ajv.compile(schema);
        if (validate) {
          // 1. generate module with a single default export (CommonJS and ESM compatible):
          return standaloneCode(ajv, validate).toString();
        } else {
          console.log({ message: 'Fail to compile schema', filePath });
          return null;
        }
      };
      const schemas = {};
      
      schemaFiles.forEach((
        file
      )=>{
        const schema = compileSchema(file);
        if(schema){
          schemas[file] = schema;
        }
       
      });
      const schemaCompiledFiles = Object.keys(schemas);
  

      let importerCode = `
      ${nonShemaFiles
        .map((module, index) => `import * as module${index} from '${module}'`)
        .join(';')}
        
        ${schemaCompiledFiles
          .map((module, index) => `const schema${index} = ${schemas[module]}`)
          .join(';')}
    
      let fileModules = [${nonShemaFiles
          .map((module, index) => `module${index}`)
          .join(',')}];
        
      const modules = fileModules.concat([${schemaCompiledFiles
          .map((module, index) => `schema${index}`)
          .join(',')}]);

        export default modules;
        export const filenames = [...[${nonShemaFiles
          .map((module, index) => `'${module}'`)
          .join(',')}], [${schemaCompiledFiles
            .map((module, index) => `'${module}'`)
            .join(',')}]]
      `;

      return { contents: importerCode, resolveDir: args.pluginData.resolveDir };
    });
  },
});

export default EsbuildPluginImportGlob;
