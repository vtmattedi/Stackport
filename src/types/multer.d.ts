// `@types/multer` can't be installed in this environment (node_modules/@types is
// root-owned and unwritable here) — this is a minimal ambient shim covering only
// the surface this codebase actually uses (memoryStorage + .fields()).
//
// Deliberately has no top-level import/export: in this TypeScript version, a
// `declare module "multer" { ... }` ambient declaration is only picked up (instead
// of silently falling back to "implicitly has an 'any' type") when this file is a
// script, not a module — adding a top-level `import` here reintroduces TS7016 on
// every consumer of `multer`. Use inline `import("express").X` types instead.
declare module "multer" {
  namespace multer {
    interface File {
      fieldname: string;
      originalname: string;
      encoding: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    }

    interface StorageEngine {
      _handleFile: (...args: unknown[]) => void;
      _removeFile: (...args: unknown[]) => void;
    }

    interface Options {
      storage?: StorageEngine;
      limits?: {
        fileSize?: number;
        files?: number;
        fields?: number;
        parts?: number;
      };
    }

    interface Field {
      name: string;
      maxCount?: number;
    }

    interface Instance {
      single: (fieldName: string) => import("express").RequestHandler;
      array: (fieldName: string, maxCount?: number) => import("express").RequestHandler;
      fields: (fields: Field[]) => import("express").RequestHandler;
      none: () => import("express").RequestHandler;
      any: () => import("express").RequestHandler;
    }

    function memoryStorage(): StorageEngine;
  }

  function multer(options?: multer.Options): multer.Instance;

  export = multer;
}

declare namespace Express {
  namespace Multer {
    interface File {
      fieldname: string;
      originalname: string;
      encoding: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    }
  }

  interface Request {
    file?: Multer.File;
    files?: Multer.File[] | Record<string, Multer.File[]>;
  }
}
