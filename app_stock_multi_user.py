
import streamlit as st
import pandas as pd
import json
from io import BytesIO
from datetime import datetime

# Chargement des utilisateurs
def load_users():
    with open("users.json", "r") as f:
        return json.load(f)

def save_users(users):
    with open("users.json", "w") as f:
        json.dump(users, f, indent=4)

def load_stock():
    with open("stock_initial.json", "r") as f:
        return json.load(f)

def save_stock(stock):
    with open("stock_initial.json", "w") as f:
        json.dump(stock, f, indent=4)

# Authentification
def authenticate(username, password, users):
    return username in users and users[username]["password"] == password

st.set_page_config(page_title="Gestion de Stock", layout="wide")
st.title("📦 Application de Gestion de Stock")

users = load_users()
stock_data = load_stock()

if "user" not in st.session_state:
    st.session_state.user = None

if not st.session_state.user:
    st.subheader("🔐 Connexion")
    username = st.text_input("Nom d'utilisateur")
    password = st.text_input("Mot de passe", type="password")
    if st.button("Se connecter"):
        if authenticate(username, password, users):
            st.session_state.user = username
            st.success(f"Bienvenue, {username} !")
            st.rerun()
        else:
            st.error("Identifiants incorrects.")

if st.session_state.user:
    role = users[st.session_state.user]["role"]
    st.sidebar.write(f"👤 Connecté en tant que **{st.session_state.user}** ({role})")

    if st.sidebar.button("🚪 Se déconnecter"):
        st.session_state.user = None
        st.rerun()

    if role == "admin":
        st.sidebar.subheader("🛠️ Gestion des utilisateurs")
        with st.sidebar.expander("➕ Créer un utilisateur"):
            new_user = st.text_input("Nom", key="new_user")
            new_pass = st.text_input("Mot de passe", type="password", key="new_pass")
            new_role = st.selectbox("Rôle", ["utilisateur", "admin"], key="new_role")
            if st.button("Créer utilisateur"):
                if new_user in users:
                    st.warning("Utilisateur déjà existant.")
                else:
                    users[new_user] = {"password": new_pass, "role": new_role}
                    save_users(users)
                    st.success("Utilisateur créé.")

        with st.sidebar.expander("🗑️ Supprimer un utilisateur"):
            del_user = st.selectbox("Sélectionner", list(users.keys()), key="del_user")
            if st.button("Supprimer utilisateur"):
                if del_user == "admin":
                    st.error("Impossible de supprimer l'administrateur.")
                else:
                    users.pop(del_user)
                    save_users(users)
                    st.success("Utilisateur supprimé.")

        st.subheader("📦 Gérer les produits")
        with st.expander("➕ Ajouter un produit"):
            nom = st.text_input("Nom du produit")
            stock = st.number_input("Stock initial", min_value=0, step=1)
            paiement = st.checkbox("Paiement Wave/Crédit autorisé")
            par_lot = st.checkbox("Produit vendu par lot de 3")
            prix_unit = st.number_input("Prix unitaire", min_value=0, step=100)
            prix_3 = st.number_input("Prix pour 3", min_value=0, step=100) if par_lot else 0
            if st.button("Ajouter le produit"):
                if nom in stock_data:
                    st.warning("Produit déjà existant.")
                else:
                    stock_data[nom] = {
                        "stock": stock,
                        "paiement": paiement,
                        "par_lot": par_lot,
                        "prix_unitaire": prix_unit,
                        "prix_par_3": prix_3
                    }
                    save_stock(stock_data)
                    st.success("Produit ajouté.")

        st.subheader("🧮 Modifier stock initial")
        for prod, infos in stock_data.items():
            new_val = st.number_input(f"{prod}", value=infos["stock"], key=f"stock_{prod}")
            stock_data[prod]["stock"] = new_val
        if st.button("💾 Enregistrer les stocks initiaux"):
            save_stock(stock_data)
            st.success("Stocks mis à jour.")

    st.subheader("📋 Saisie journalière des ventes")
    data = []
    for prod, info in stock_data.items():
        with st.expander(prod):
            col1, col2, col3 = st.columns(3)
            entree = col1.number_input(f"Entrée ({prod})", min_value=0, step=1, key=f"e_{prod}")
            sortie = col2.number_input(f"Vente ({prod})", min_value=0, step=1, key=f"v_{prod}")
            stock_final = info["stock"] + entree - sortie

            if info["par_lot"]:
                lots = sortie // 3
                reste = sortie % 3
                montant = lots * info["prix_par_3"] + reste * info["prix_unitaire"]
            else:
                montant = sortie * info["prix_unitaire"]

            st.markdown(f"💰 **Montant vente : {montant} FCFA**")
            pay_wave = pay_credit = 0
            if info["paiement"]:
                pay_wave = st.number_input(f"Wave ({prod})", min_value=0, step=100, key=f"w_{prod}")
                pay_credit = st.number_input(f"Crédit ({prod})", min_value=0, step=100, key=f"c_{prod}")
            pay_caisse = st.number_input(f"Caisse ({prod})", min_value=0, step=100, key=f"caisse_{prod}")

            total_paiement = pay_wave + pay_credit + pay_caisse
            if total_paiement != montant:
                st.error(f"Total paiement ({total_paiement}) ≠ montant vente ({montant})")
            data.append([prod, info["stock"], entree, sortie, stock_final, info["prix_unitaire"],
                         montant, pay_wave, pay_credit, pay_caisse])

    if st.button("📥 Générer rapport"):
        df = pd.DataFrame(data, columns=[
            "Produit", "Stock initial", "Entrée", "Vente", "Stock final", "Prix unitaire",
            "Montant vente", "Wave", "Crédit", "Caisse"
        ])
        total_row = df[["Montant vente", "Wave", "Crédit", "Caisse"]].sum()
        total_row["Produit"] = "TOTAL"
        total_row_df = pd.DataFrame([total_row])

        st.success("✅ Rapport généré")
        st.dataframe(df)

        output = BytesIO()
        with pd.ExcelWriter(output, engine="xlsxwriter") as writer:
            df.to_excel(writer, index=False, sheet_name="Rapport")
            total_row_df.to_excel(writer, index=False, startrow=len(df)+2, sheet_name="Rapport")
        output.seek(0)

        date_str = datetime.now().strftime("%Y-%m-%d")
        st.download_button("📄 Télécharger le rapport Excel",
                           data=output,
                           file_name=f"rapport_{st.session_state.user}_{date_str}.xlsx")
