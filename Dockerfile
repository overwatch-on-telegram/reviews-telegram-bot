# Utilisez une image Node.js officielle comme image de base
FROM node:20

# Définissez le répertoire de travail dans le conteneur
WORKDIR /usr/src/app

# Copiez les fichiers package.json et package-lock.json (si disponible)
COPY package*.json ./

ARG GITHUB_TOKEN

# Exécutez la commande pour ajouter le token à npm et installer les dépendances
RUN echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" > .npmrc && \
    echo "@overwatch-on-telegram:registry=https://npm.pkg.github.com/" >> .npmrc && \
    npm install

# Copiez le reste des fichiers de l'application dans le conteneur
COPY . .

# Définissez la commande pour exécuter votre application
CMD [ "npm", "start" ]