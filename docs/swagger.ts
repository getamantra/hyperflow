import swaggerJSDoc from 'swagger-jsdoc'
import { fileURLToPath } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Hyperflow APIs',
      version: '1.0.0',
      description: `## Hyperflow API Documentation.
      Note: Please go through the [README.md] file for a better understanding of Hyperflow.
`,
    },
    servers: process.env.SWAGGER_HOST ? [{ url: process.env.SWAGGER_HOST }] : [],
  },
  apis: [path.join(__dirname, './swagger-paths/**/*.yaml')],
})
