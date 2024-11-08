/* global WeakMap */
const Joi = require('joi');
const Hoek = require('@hapi/hoek');
const Bourne = require('@hapi/bourne');

function randomString(length) {
    return Math.round((Math.pow(36, length + 1) - Math.random() * Math.pow(36, length))).toString(36).slice(1);
}

class SchemaResolver {
    constructor(root, { subSchemas, refineType, refineSchema, strictMode, useDefaults, extensions = [] }) {
        this.root = root;
        this.subSchemas = subSchemas;
        this.refineType = refineType;
        this.refineSchema = refineSchema;
        this.strictMode = strictMode;
        this.walkedSchemas = new WeakMap(); // map of schemas iterated thus far to the generated id they were given
        this.useDefaults = useDefaults;

        this.joi = Joi.extend(
            {
                type: 'object',
                base: Joi.object(),
                coerce: {
                    from: 'string',
                    method(value) {
                        if (typeof value !== 'string' || (value[0] !== '{' && !/^\s*\{/.test(value))) {
                            return;
                        }

                        try {
                            return { value: Bourne.parse(value) };
                        } catch (ignoreErr) { } // eslint-disable-line no-empty
                    }
                }
            },
            {
                type: 'array',
                base: Joi.array(),
                coerce: {
                    from: 'string',
                    method(value) {
                        if (typeof value !== 'string' || (value[0] !== '[' && !/^\s*\[/.test(value))) {
                            return;
                        }
                        try {
                            return { value: Bourne.parse(value) };
                        } catch (ignoreErr) { } // eslint-disable-line no-empty
                    }
                }
            },
            ...extensions
        );
    }

    resolve(schema = this.root, ancestors = []) {
        let resolvedSchema;
        let generatedId = this.walkedSchemas.get(schema);

        if (generatedId && ancestors.lastIndexOf(generatedId) > -1) {
            // resolve cyclic schema by using joi reference via generated unique ids
            return this.resolveLink(schema)
        } else if (typeof schema === 'object') {
            generatedId = randomString(10)
            this.walkedSchemas.set(schema, generatedId)
        }

        if (typeof schema === 'string') {
            // If schema is itself a string, interpret it as a type
            resolvedSchema = this.resolveType({ type: schema });
        } else if (schema.$ref) {
            resolvedSchema = this.resolve(this.resolveReference(schema.$ref), ancestors.concat(generatedId));
        } else {
            const partialSchemas = [];
            if (schema.type) {
                partialSchemas.push(this.resolveType(schema, ancestors.concat(generatedId)));
            } else if (schema.properties) {
                // if no type is specified, just properties
                partialSchemas.push(this.object(schema, ancestors.concat(generatedId)))
            } else if (schema.format) {
                // if no type is specified, just format
                partialSchemas.push(this.string(schema))
            } else if (schema.enum) {
                // If no type is specified, just enum
                partialSchemas.push(this.joi.any().valid(...schema.enum));
            }
            if (schema.anyOf) {
                partialSchemas.push(this.resolveAnyOf(schema, ancestors.concat(generatedId)));
            }
            if (schema.allOf) {
                partialSchemas.push(this.resolveAllOf(schema, ancestors.concat(generatedId)));
            }
            if (schema.oneOf) {
                partialSchemas.push(this.resolveOneOf(schema, ancestors.concat(generatedId)));
            }
            if (schema.not) {
                partialSchemas.push(this.resolveNot(schema, ancestors.concat(generatedId)));
            }
            if (partialSchemas.length === 0) {
                //Fall through to whatever.
                //eslint-disable-next-line no-console
                console.warn('WARNING: schema missing a \'type\' or \'$ref\' or \'enum\': \n%s', JSON.stringify(schema, null, 2));
                //TODO: Handle better
                partialSchemas.push(this.joi.any());
            }
            resolvedSchema = partialSchemas.length === 1 ? partialSchemas[0] : this.joi.alternatives(partialSchemas).match('all');
        }

        if (generatedId) {
            // we have finished resolving the schema, now attach the id generated earlier
            resolvedSchema = resolvedSchema.id(this.walkedSchemas.get(schema))
        }

        if (this.refineSchema) {
            resolvedSchema = this.refineSchema(resolvedSchema, schema);
        }

        if (this.useDefaults && schema.default !== undefined) {
            resolvedSchema = resolvedSchema.default(schema.default)
        }

        return resolvedSchema;
    }

    resolveReference(value) {
        let refschema;

        const id = value.substr(0, value.indexOf('#') + 1);
        const path = value.substr(value.indexOf('#') + 1);

        if (id && this.subSchemas) {
            refschema = this.subSchemas[id] || this.subSchemas[id.substr(0, id.length - 1)];
        }
        if (!refschema) {
            refschema = this.root;
        }

        Hoek.assert(refschema, 'Can not find schema reference: ' + value + '.');

        let fragment = refschema;
        const paths = path.split('/');

        for (let i = 1; i < paths.length && fragment; i++) {
            fragment = typeof fragment === 'object' && fragment[paths[i]];
        }

        return fragment;
    }

    resolveType(schema, ancestors) {
        let joischema;

        const typeDefinitionMap = {
            description: 'description',
            title: 'label',
            default: 'default'
        };

        const joitype = (type, format) => {
            let joischema;

            if (this.refineType) {
                type = this.refineType(type, format);
            }

            switch (type) {
                case 'array':
                    joischema = this.array(schema, ancestors);
                    break;
                case 'boolean':
                    joischema = this.joi.boolean();
                    break;
                case 'integer':
                case 'number':
                    joischema = this.number(schema);
                    break;
                case 'object':
                    joischema = this.object(schema, ancestors);
                    break;
                case 'string':
                    joischema = this.string(schema);
                    break;
                case 'null':
                    joischema = this.joi.any().valid(null);
                    break;
                default:
                    joischema = this.joi.types()[type];
            }

            Hoek.assert(joischema, 'Could not resolve type: ' + schema.type + '.');

            return joischema.strict(this.strictMode);
        }

        if (Array.isArray(schema.type)) {
            const schemas = [];

            for (let i = 0; i < schema.type.length; i++) {
                schemas.push(joitype(schema.type[i], schema.format));
            }

            joischema = this.joi.alternatives(schemas);
        }
        else {
            joischema = joitype(schema.type, schema.format);
        }

        Object.keys(typeDefinitionMap).forEach(function (key) {
            if (schema[key] !== undefined) {
                joischema = joischema[typeDefinitionMap[key]](schema[key]);
            }
        });

        return joischema;
    }

    resolveOneOf(schema, ancestors) {
        Hoek.assert(Array.isArray(schema.oneOf), 'Expected oneOf to be an array.');

        return this.joi.alternatives(schema.oneOf.map(schema => this.resolve(schema, ancestors))).match('one');
    }

    resolveAnyOf(schema, ancestors) {
        Hoek.assert(Array.isArray(schema.anyOf), 'Expected anyOf to be an array.');

        return this.joi.alternatives(schema.anyOf.map(schema => this.resolve(schema, ancestors))).match('any');
    }

    resolveAllOf(schema, ancestors) {
        Hoek.assert(Array.isArray(schema.allOf), 'Expected allOf to be an array.');

        return this.joi.alternatives(schema.allOf.map(schema => this.resolve(schema, ancestors))).match('all');
    }

    resolveNot(schema, ancestors) {
        Hoek.assert(typeof schema.not === 'object' && schema.not !== null, 'Expected Not to be an object.');

        return this.joi.alternatives().conditional(
          '.',
          {
              not: this.resolve(schema.not, ancestors),
              then: this.joi.any(),
              otherwise: this.joi.any().forbidden()
          }
        );
    }

    resolveLink(schema) {
        return this.joi.link().ref(`#${this.walkedSchemas.get(schema)}`)
    }

    object(schema, ancestors) {

        const resolveproperties = () => {
            const schemas = {};

            if (typeof schema.properties !== 'object' || schema.properties === null) {
                return;
            }

            Object.keys(schema.properties).forEach((key) => {
                const property = schema.properties[key];

                let joischema = this.resolve(property, ancestors);

                if (schema.required && !!~schema.required.indexOf(key)) {
                    joischema = joischema.required();
                }

                schemas[key] = joischema;
            });

            return schemas;
        }

        let joischema = this.joi.object(resolveproperties(schema));

        if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
            joischema = joischema.pattern(/^/, this.resolve(schema.additionalProperties, ancestors));
        } else {
            joischema = joischema.unknown(schema.additionalProperties !== false);
        }

        typeof schema.minProperties === 'number' && (joischema = joischema.min(schema.minProperties));
        typeof schema.maxProperties === 'number' && (joischema = joischema.max(schema.maxProperties));

        return joischema;
    }

    array(schema, ancestors) {
        let joischema = this.joi.array();
        let items;

        const resolveAsArray = (value) => {
            if (Array.isArray(value)) {
                // found an array, thus its _per type_
                return value.map((v) => this.resolve(v, ancestors));
            }
            // it's a single entity, so just resolve it normally
            return [this.resolve(value, ancestors)];
        }

        if (schema.items) {
            items = resolveAsArray(schema.items);

            joischema = joischema.items(...items);
        }
        else if (schema.ordered) {
            items = resolveAsArray(schema.ordered);
            joischema = joischema.ordered(...items);
        }

        if (items && schema.additionalItems === false) {
            joischema = joischema.max(items.length);
        }

        typeof schema.minItems === 'number' && (joischema = joischema.min(schema.minItems));
        typeof schema.maxItems === 'number' && (joischema = joischema.max(schema.maxItems));

        if (schema.uniqueItems) {
            joischema = joischema.unique();
        }

        return joischema;
    }

    number(schema) {
        let joischema = this.joi.number();

        if (schema.type === 'integer') {
            joischema = joischema.integer();
        }

        typeof schema.minimum === 'number' && (joischema = joischema.min(schema.minimum));
        typeof schema.maximum === 'number' && (joischema = joischema.max(schema.maximum));
        typeof schema.exclusiveMinimum === 'number' && (joischema = joischema.greater(schema.exclusiveMinimum));
        typeof schema.exclusiveMaximum === 'number' && (joischema = joischema.less(schema.exclusiveMaximum));
        typeof schema.multipleOf === 'number' && schema.multipleOf !== 0 && (joischema = joischema.multiple(schema.multipleOf));

        return joischema;
    }

    string(schema) {
        let joischema = this.joi.string();

        const dateRegex = '(\\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])';
        const timeRegex = '([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9]|60)(.[0-9]+)?(Z|(\\+|-)([01][0-9]|2[0-3]):([0-5][0-9]))';
        const dateTimeRegex = dateRegex + 'T' + timeRegex;

        if (schema.enum) {
            return this.joi.string().valid(...schema.enum);
        }

        switch (schema.format) {
            case 'date':
                return joischema.regex(new RegExp('^' + dateRegex + '$', 'i'), 'JsonSchema date format');
            case 'time':
                return joischema.regex(new RegExp('^' + timeRegex + '$', 'i'), 'JsonSchema time format');
            case 'date-time':
                return joischema.regex(new RegExp('^' + dateTimeRegex + '$', 'i'), 'JsonSchema date-time format');
            case 'binary':
                joischema = this.binary(schema);
                break;
            case 'email':
                return joischema.email();
            case 'hostname':
                return joischema.hostname();
            case 'ipv4':
                return joischema.ip({
                    version: ['ipv4']
                });
            case 'ipv6':
                return joischema.ip({
                    version: ['ipv6']
                });
            case 'uri':
                return joischema.uri();
            case 'byte':
                joischema = joischema.base64();
                break;
            case 'uuid':
                return joischema.guid({ version: ['uuidv4'] });
            case 'guid':
                return joischema.guid();
        }
        return this.regularString(schema, joischema);
    }

    regularString(schema, joischema) {
        schema.pattern && (joischema = joischema.regex(new RegExp(schema.pattern)));

        if (schema.minLength === undefined) {
            schema.minLength = 0;
            if (!schema.pattern && !schema.format) {
                joischema = joischema.allow('');
            }
        } else if (schema.minLength === 0) {
            joischema = joischema.allow('');
        }
        typeof schema.minLength === 'number' && (joischema = joischema.min(schema.minLength));
        typeof schema.maxLength === 'number' && (joischema = joischema.max(schema.maxLength));
        return joischema;
    }

    binary(schema) {
        let joischema = this.joi.binary();
        typeof schema.minLength === 'number' && (joischema = joischema.min(schema.minLength));
        typeof schema.maxLength === 'number' && (joischema = joischema.max(schema.maxLength));
        return joischema;
    }
}

module.exports = SchemaResolver;
